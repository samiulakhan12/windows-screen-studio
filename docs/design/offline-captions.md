# Offline captions and the speech detector (F-01, F-13 minimal, F-03): final design

Status: contracts committed on `feat/offline-captions-contracts` (shared types and the model
catalog, the sidecar protocol, the IPC channels and the preload API, the transcriber choice for
E-01, the shared error sentences, the time estimate, the shipped speech detector model and the
speech fixtures, stubs with frozen signatures, and a starting crate copied from the spike), then
revised after two reviews (§13). The bodies are built by the three workstreams at the
end of this document. Roadmap items: `docs/ROADMAP.md` F-01 (with LT-20), F-03, and the minimal
model manager of F-13; it is also the way out of the OpenAI shutdown of `whisper-1` on
26 February 2027 (NW-09's deadline).

What ships:

- **Captions on this PC.** A new transcriber, "On this PC", next to the user's OpenAI and Gemini
  keys: no key, no upload, no cost, and nothing that a provider can switch off. It returns the
  same `Transcript` / `CaptionSegment` / `CaptionWord` data as the cloud providers today, so
  karaoke captions, the caption track, transcript editing, SRT/VTT export, the AI text tools and
  the director's transcript refinement work unchanged. It is the default when no key can
  transcribe.
- **The engine** is whisper.cpp 1.8.3 in a small Rust sidecar, `ssw-speech`, with DTW word
  timings (median word-start error 45 ms on forced-aligned speech), run as short-lived child
  processes at below-normal priority, one per part of at most 10 minutes, with progress, cancel
  and resume. A Linux build of the same crate runs the end-to-end tests here.
- **A minimal model manager.** Four Whisper models (44, 60, 190 and 574 MB) downloaded only after
  a click that names the size, from a pinned Hugging Face commit, resumable, cancellable,
  verified by SHA-256, removable, stored under userData, parsed by the engine and never executed.
  Default: Whisper base (60 MB; about 3 min for a 20-minute recording on a 4-core PC).
- **The speech detector.** Silero VAD v6.2.0 (MIT, 885 KB) ships in the installer and runs in the
  same sidecar at about 400 times real time on one core. Remove silences, Smart speed, music
  ducking and the camera director react to speech instead of keyboard clatter and fans, through
  an optional field on the levels they already share; today's detector is the fallback.
- **Third-party notices**, generated at build time and shown from About.
- Installer growth: **about 2.8 MB** (116.8 MB to about 119.6 MB), about 8.1 MB installed.

---

## 1. Decisions

Two designs were compared: A (engineering first) and B (user first). Both chose the same engine,
default model and integration point, so the comparison is about process control, the speech
detector's data, and the user experience.

**Base: design A.** Its engine side is the stronger one: one sidecar process per part (crash
isolation, bounded memory, a retry per part), finished parts cached by their content so a
cancelled or crashed job resumes, model and speech detector files opened by Rust and handed to
whisper.cpp through loader callbacks (MinGW's whisper.cpp opens paths with a narrow `ifstream`,
so a non-ASCII Windows user name would otherwise break both models), a CPU probe that runs the
baseline build so it can never fault, a stall watchdog, parent-death guards, the speech detector
returning per-frame probabilities with the hysteresis in tested TypeScript, results persisted per
project, and the "trust guard" that keeps a silent typing tutorial from becoming all silence.

**Grafted from B:**

| From B | Why |
|---|---|
| **Plain tiers** (Fast, Standard, Accurate, Most accurate) as chips in the Captions tab, each labelled with its size or "Downloaded", and **the time for this recording** under them | The choice is about speed against accuracy; the tab names the tier first and the model once in brackets; bare model names stay in Settings and the summary. |
| Progress in **recording time** ("8:30 of 20:00"), a time left, and a **"Heard:"** line with the newest words | Minutes-long jobs need a sign of life and a sense of quality before the end. |
| **Estimate model**: catalog RTF × thread factor × 1.3 (measured wine overhead), replaced by this PC's measured speed after the first run | Conservative before it knows, exact after. |
| **Voice tails**: a speech range extends into the touching level-based sound by up to 0.3 s after and 0.1 s before | Silero pads only 30 ms; soft word endings would be clipped by Remove silences. |
| A **status line in the Clip tab** saying what counts as sound (`data-detector`) | The meaning of "sound" changes; the user is told which detector ran. |
| A **captions job badge** on the Captions tab and a "Captions ready" notice | The user keeps editing other tabs while a local job runs for minutes. |
| **"Not English?"** link and the hint that small models make more mistakes in other languages | Auto-detection was verified on English only. |
| **Cloud errors offer "Make them on this PC instead"** | The path off `whisper-1` when OpenAI removes it. |
| **Show folder** in Settings; a download that stopped always needs a click to continue | Metered connections; nothing downloads by itself. |
| The **regression lock**: without speech ranges, `sourceActivity` returns exactly today's ranges | The fallback is provably today's behaviour. |
| `pickTranscriber` returns a `ready` flag, so E-01 can tell "local but needs consent" | E-01 never starts a download. |

**Conflicts resolved:**

| Topic | A | B | Decision |
|---|---|---|---|
| Sidecar name | `ssw-speech` | `ssw-whisper` | **`ssw-speech`**: it also runs the speech detector. |
| Fast and Accurate files | tiny q5_1, small q5_1 behind a release gate | tiny f16 (78 MB), small f16 (488 MB): measured files only | **Measured here and gated now** (§2.2): tiny q5_1 failed the gate (WER 10.0 % against 8.7 %), tiny **q8_0** passed (8.3 %, 44 MB); small **q5_1** passed (7.9 % against 7.4 %, same speed, 557 MB of memory against 841, 190 MB download against 488). |
| Compatible build | x86-64 baseline (every SIMD option off) | SSE4.2 | **Baseline**: it can never fault on any x64 processor, which is what the CPU probe needs; the speed difference to SSE4.2 is small next to the 4.3x lost without AVX2. The standard build also checks CPUID at the start of `main` (B), but code compiled for AVX2 can run in static initialisers before it, so the illegal-instruction exit is the real guard (§2.4). |
| Speech detector output | per-frame probabilities, hysteresis in TS | ranges from whisper.cpp | **Probabilities (A)**: tunable without a native rebuild, the cache survives a constant change, windows stitch trivially; 150 KB per hour. |
| Field on `AudioLevels` | `speech?` | `voice?` | **`speech?`** (one name with the detector). |
| Resume | finished parts cached by content | a checkpoint file plus `--start` inside a part | **A**: a cache keyed by the part's SHA-256, the model's SHA-256, the language and the engine version is correct by construction; at most one part is redone, which on a 4-core Windows PC is up to about 40 s of work for tiny, 1.3 min for base, 2.4 min for small and 5.6 min for turbo (§2.2). A "Continue" card on reopening is later (§11). |
| Downloads at once | one | one per model | **One**: simpler, and a second would only share the bandwidth. |
| Automatic retries | 3 (after 2, 5, 15 s), each resuming | none | **A**: flaky connections resume without a click; a stopped download (cancel, quit) still needs one. |
| Free space | remaining bytes + 64 MB | size + 10 % + 50 MB | **A**. |
| Stall watchdog | 300 s | 120 s | **Neither alone** (§3.4): whisper.cpp 1.8.3 reports progress only at the top of each 30 s window, and one window of turbo on the compatible build at 2 threads takes about 330 s on Windows. So the helper prints a **heartbeat** at least every 15 s, main kills it after **120 s** without a line (a frozen process), and a part may run at most **max(10 min, 4 × its estimate)** (whisper.cpp not moving on). Turbo is not offered on the compatible build. |
| Line cap | 4 MB | 1 MB | **1 MB per line** (segments are streamed one per line; the result line carries no words) and **64 MB in all** (A). |
| Whisper large-v3 turbo on small PCs | download disabled below 8 GB in all | a memory warning | **A** for turbo (about 1.1 GB needed at RTF 1.14), and also not offered where only the compatible build runs (about 8 times the recording's length there); **B's warning** for small when free memory is short (tiny and base need under 400 MB). |
| Model ids | tier ids (`whisper-base`) | file ids (`whisper-base-q5_1`) | **Tier ids**: a pin can change (as small did here) without touching stored transcripts or settings. |
| Settings files | `installed.json` + `settings.json` | one `speech.json` | **One `speech.json`** written atomically by one store. |
| Where `pickTranscriber` lives | a new renderer file | `captionItems.ts` | **`src/shared/speech/transcriber.ts`**, pure and committed now: E-01 imports a stable function, and `captionItems.ts` (which E-01 may touch) is not changed for it. |
| Windows process mitigations | including Microsoft-signed-only image loads | none | **A without MicrosoftSignedOnly**: it can break security products that inject DLLs and cannot be tested here; later after a Windows check. |
| Speech for `'mix'` | only when the recording kept no stems | always | **Only when the project folder has no `mic.m4a`** (no project read needed; the mixed track is still measured for loudness when the stems play at default gains, and running the detector on it then would be wasted). |
| Section title in Settings | Speech models | Captions on this PC | **"Captions on this PC"** (section id `speech`). |

**Measured for this decision** (same container, binary and scripts as the spike; results in the
spike folder under `results/judge/`):

| File | Download | Wall on the 105.7 s clip | RTF | Peak RSS | WER | Word start (median / p90 / within 200 ms) |
|---|---|---|---|---|---|---|
| ggml-tiny-q5_1.bin | 32.2 MB | 4.73 s | 0.045 | 242 MB | 10.0 % | 75 / 175 ms / 94.2 % |
| ggml-tiny-q8_0.bin | 43.5 MB | 4.41 s | 0.042 | 252 MB | 8.3 % | 75 / 175 ms / 94.8 % |
| ggml-small-q5_1.bin | 190.1 MB | 30.96 s | 0.293 | 557 MB | 7.9 % | 45 / 215 ms / 88.7 % |

The gate (from A): a quantised file replaces the f16 one when its WER is at most 0.5 points higher,
its p90 word-start error at most 20 ms higher and its RTF at most 1.1 times. WER on one 229-word
clip is noisy (one point is about two words); the gate is deliberately strict.

**Cut to later** (§11): a Vulkan/GPU build, Parakeet TDT, speaker labels, fillers and retakes
(F-05), streaming input and mid-part resume, a remote or mirrored catalog, English-only models,
the speech detector on PC sound, and the process mitigations wine cannot test.

---

## 2. Engine, models and builds

### 2.1 Engine: whisper.cpp in a Rust sidecar

whisper.cpp 1.8.3 and ggml 0.9.5 (MIT), vendored by the crate `whisper-rs-sys = "=0.15.0"`
(Unlicense, the newest on crates.io), used as raw FFI. Measured on the 4-core reference container:

- **Word timings.** DTW token times with refinements (a word ends at the DTW time of its last
  letter or digit token; a start that swallowed a pause is pulled in; a start snaps to a speech
  onset found by the detector inside it), applied **per chunk before each segment line is
  printed** (§5.2), because the `segment` lines are all main receives: base q5_1 word starts
  median 45 ms, p90 145 ms, 92.4 % within 200 ms; ends 55 / 145 ms / 94.8 % (tiny 75 / 175 ms /
  94.8 %, small 45 / 215 ms / 88.7 %, turbo 45 / 185 ms / 90.4 %). These are the spike's segment
  lines refined per chunk by `native/speech/bench/eval_stream.py`, which reproduces the spike's
  whole-run figures exactly when run on the whole run (45 / 155 ms / 91.9 %); the spike's segment
  lines without the refinements gave 55 / 320 ms / 83.9 %. Workstream A re-measures from its own
  helper's lines (gate: median ≤ 50 ms, ≥ 90 % within 200 ms). The older token timestamps gave
  120 / 495 ms / 65.9 %. DTW needs `flash_attn = false`.
- **Long recordings.** A 60-minute recording (34 repeats of the clip) took 215 s (RTF 0.060) with
  524 MB peak memory in one process; 210-211 matched words in every repeat, no drift.
- **Windows.** The static exe is 3,585,024 bytes, imports only KERNEL32, ADVAPI32, msvcrt, ntdll
  and api-ms-win-core-synch-l1-2-0, and under wine gave the same 226 words as Linux within 40 ms
  (base q5_1 RTF 0.105). Closing stdin cancelled it in 0.03 s.
- **Language.** Auto-detection works with the multilingual models (verified on English only).

Rejected:

- **transformers.js + onnxruntime-node**: needs the MSVC runtime DLLs and a stub for sharp, has no
  language detection ("TODO" in 4.3.1; it falls back to English), computes features for the whole
  file up front (1,379 MB for 2 minutes, 1,566 MB for 10 minutes with base), its DTW word ends ran
  into pauses (median +0.71 s), and it adds about 8.5 MB plus the runtime.
- **sherpa-onnx**: no Whisper word timings. Its Parakeet TDT v3 (WER 5.1 %, 5.9-9 times real time)
  is a 670 MB CC-BY-4.0 download for 25 European languages: later, optional.

### 2.2 The models (`src/shared/speech/catalog.ts`, frozen)

All from `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/<file>`
(Hugging Face licence tag MIT; the weights are OpenAI Whisper, MIT, "Copyright (c) 2022 OpenAI").
All are multilingual, so one list serves "Detect automatically"; English-only models are not
offered (tiny.en measured 8.3 % against tiny's 8.7 %: within noise, and they cannot detect).

| Id | Tier | File | Bytes | SHA-256 | RTF (4 threads) | Peak memory | WER | Start median | Part |
|---|---|---|---|---|---|---|---|---|---|
| `whisper-tiny` | Fast | ggml-tiny-q8_0.bin | 43,537,433 | c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca | 0.042 | 252 MB | 8.3 % | 75 ms | 600 s |
| `whisper-base` (default) | Standard | ggml-base-q5_1.bin | 59,707,625 | 422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898 | 0.079 | 311 MB | 8.7 % | 45 ms | 600 s |
| `whisper-small` | Accurate | ggml-small-q5_1.bin | 190,085,487 | ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb | 0.293 | 557 MB | 7.9 % | 45 ms | 300 s |
| `whisper-turbo` | Most accurate (slow) | ggml-large-v3-turbo-q5_0.bin | 574,041,195 | 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2 | 1.138 | 1,014 MB | 5.7 % | 45 ms | 180 s |

- **Why base is the default:** a one-click 60 MB download, the best measured timing (45 ms), an
  hour of recording in about 8 minutes on a 4-core Windows PC (estimate, §3.3), about 400 MB of
  memory. Small is 3.7 times slower for 0.8 points; turbo is slower than real time on CPUs.
- **Turbo** can be downloaded and used only on PCs with at least 8 GB of memory in all
  (`minTotalMemGB`; an "8 GB" PC can report as little as 7 GB because the graphics chip keeps
  some, so the bar is 7 GiB) and a processor that runs the standard build (`needsStandardBuild`:
  on the compatible build it would take about 8 times the recording's length).
  `speechModelBlock` (catalog.ts) decides both; elsewhere it is listed in Settings, disabled, with
  `modelBlockReason` (errors.ts). The Captions tab offers it as a chip only once it is downloaded
  (from Settings): 38 minutes for a 20-minute recording invites a bad pick.
- **Parts:** each engine run transcribes at most `partSeconds` of the recording (one process per
  part, §3.2). On the reference PC (4 threads) that is up to 25 s of work for tiny, 47 s for base,
  88 s for small and 205 s for turbo; on a 4-core Windows PC (3 threads, × 1.65) about 40 s,
  1.3 min, 2.4 min and 5.6 min. A crash, stall or cancel redoes at most one part.
- `memoryNeedMB(spec)` = peak + part samples (64 KB/s) + 50 MB: 340 / 399 / 626 / 1,076 MB. Less
  free memory than this gives a warning for small (tiny and base need under 400 MB), never a
  refusal.

### 2.3 The speech detector model

`resources/speech/ggml-silero-v6.2.0.bin`: Silero VAD v6.2.0 in ggml format, 885,098 bytes,
SHA-256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`, from
`https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin`,
MIT ("Copyright (c) 2020-present Silero Team"). Committed in the repository (752,208 bytes after
xz) so every test runs offline. On one thread: 406 times real time on the 105.7 s clip,
10.6 minutes in 1.57 s with 49.5 MB of memory, 2.5 ms to load; on four threads 21 times real time,
so it **always runs on one thread** (`VAD_THREADS`).

### 2.4 Builds and processor tiers

| Build | File | ggml flags | Runs on |
|---|---|---|---|
| Standard | `ssw-speech.exe` | `GGML_NATIVE=OFF`, `GGML_SSE42/AVX/AVX2/FMA/F16C/BMI2=ON` | SSE4.2 + AVX + AVX2 + FMA + F16C + BMI2 (Intel Haswell 2013+, AMD Zen) |
| Compatible | `ssw-speech-compat.exe` | `GGML_NATIVE=OFF`, every extension OFF | any x64 processor; expected about 4.3 times slower (the unforced cross build measured 25.7 s against 6.0 s for tiny.en under wine) |
| Host (development, tests) | `native/bin/ssw-speech` | `GGML_NATIVE=OFF` on a native build (SSE4.2 through AVX2 on) | the build machine (Linux here) |

Selection, once per app session (main, `selectHelper`):

1. Run `ssw-speech-compat.exe cpu` (baseline code; Rust's feature detection executes no SIMD),
   in `os.tmpdir()` with `--parent-pid`.
2. SSE4.2, AVX, AVX2, FMA, F16C and BMI2 all present (`chooseBuild`; some virtual machines and
   emulators offer AVX2 without BMI2): standard; otherwise compatible.
3. The standard build also checks CPUID at the start of `main` and exits with error code `cpu`
   if something is missing. That check is a second line only: ggml-cpu's C++ static initialisers
   are compiled with `-mavx2` and run before `main`, so a wrong choice can fault first. The real
   guard: an exit with STATUS_ILLEGAL_INSTRUCTION (0xC000001D) or SIGILL from **any** subcommand
   (`transcribe` or `vad`), like error `cpu`, switches to the compatible build for the session
   (`markIllegalInstruction`) and retries once; the speech detector is not turned off for it.
4. Development and Linux: the host build only; `SSW_SPEECH_HELPER` replaces it (unpackaged only,
   like `SSW_CAPTURE_HELPER` in `nativeCapture.ts`).

Two static executables reuse the existing every-`.exe` signing pass; ggml's per-CPU backend
DLLs were rejected (a DLL search surface, `.dll` would join `SIGN_EXTS`, more files to verify).

### 2.5 Run settings

- Transcription threads: `speechThreads(cores)` = cores − 1, at least 1, at most 8 (3 on the
  4-core reference). Measured base scaling: 1 thread RTF 0.247, 2 threads 0.137, 4 threads 0.077.
- `--low-priority`: BELOW_NORMAL_PRIORITY_CLASS on Windows, nice 10 on Linux.
- `whisper_init_with_params_no_state` (through the loader) plus one `whisper_init_state`: the
  plain init allocates an unused state (base 431 → 395 MB, small 927 → 841 MB).
- Greedy decoding, `flash_attn = false`, `dtw_token_timestamps = true`, the alignment-heads preset
  chosen from the model header, `token_timestamps = false`, all `print_*` off, whisper and ggml
  logs silenced unless `--verbose`.
- The sidecar runs the speech detector on the part itself and packs speech into chunks of at most
  29 s (`SIDECAR.maxChunk`), split in silences, each padded by 0.25 s but never past the middle of a
  gap; each chunk is transcribed with `whisper_full_with_state` and its offset added. Never
  `whisper_full`'s own VAD: its token and DTW times stay in compressed time. Speech that runs on
  past a chunk is cut at its quietest frame: the lowest detector probability in the 8 s before
  the limit, at least 1 s before the speech ends (`chunks::plan`). whisper.cpp's
  `max_speech_duration_s` is not used: it cuts at whatever frame passes the limit, and its merge
  of gaps under 200 ms joins the pieces again.
- **Language** with `--lang auto`: after the speech detector and the chunk plan, the helper
  detects the language once, on the first chunk that holds at least `SIDECAR.detectMinSpeech`
  (10 s) of speech, else on the chunk with the most speech (`whisper_pcm_to_mel_with_state` and
  `whisper_lang_auto_detect_with_state` on that chunk: one extra encoder pass, which cannot be
  aborted), then transcribes every chunk with that language. The result line reports it with
  `language_s`, the seconds of speech the detection heard (0 when the language was given;
  `language` is '' when the part held no speech). The client carries a detected language to later
  parts only from a part with `language_s` ≥ 10 (§3.2), so an opening "OK" followed by a long
  pause never decides an hour's language. Without such a part every part detects its own.

---

## 3. Behaviour

### 3.1 The model manager (main: `src/main/speech/models.ts`, `download.ts`)

**Consent.** A download starts only from a click on a button whose text names the model's size:
the consent card in the Captions tab, or a model row in Settings › Captions on this PC. Never
from the "Generate captions" command, E-01, app start, a failed transcription, or a resume after
restart.

**A download:**

1. **Check.** The id must be a catalog id (`speechModel`), the PC must be allowed to have it
   (`speechModelBlock`: turbo needs 8 GB in all and the standard build), and no other download
   may be running ("Another speech model is
   downloading."). Free space (`fs.statfs` on the models folder) must be at least the bytes still
   to fetch plus 64 MB, else it fails with `disk`.
2. **Request.** GET the pinned URL (`modelUrl`) with Electron `net.request`: system proxies and
   Chromium's TLS, `redirect: 'manual'`, no credentials or cookies, User-Agent `Flown/<version>`.
   Redirects are followed by hand, at most 5, each to `https:` on `huggingface.co`,
   `*.huggingface.co` or `*.hf.co` (the spike saw a 302 to `us.aws.cdn.hf.co` with
   `x-linked-size` and `x-linked-etag` = the SHA-256). Anything else fails with `other`.
3. **Resume.** Each attempt sends `Range: bytes=<.part size>-` to the **pinned** URL (signed CDN
   addresses expire). 206 with `Content-Range` starting at the .part size and a total equal to the
   pin: append. 200: truncate and start over. 416, or any other total: delete the .part and start
   over once. The spike measured `206 bytes 1000-1999/147951465`. A .part that already holds
   every byte (an install that failed after the check, such as a rename an antivirus held) sends
   no request: it is hashed and, when it matches the pin, installed (step 6); otherwise deleted.
4. **Write and hash.** Bytes stream into `<file>.part` with back-pressure while SHA-256 updates;
   on resume the existing prefix is hashed first (574 MB in about a second). `<file>.part.json`
   records `{ version: 1, id, bytes, sha256, received, updatedAt }`. Progress reaches the renderer
   at most 4 times a second (`speech:changed`) with received, total and a 5-second average speed.
5. **Stalls and errors.** No byte for 60 s aborts the attempt. Network errors and stalls are
   retried 3 times (after 2, 5 and 15 s), each resuming; meanwhile the status stays `downloading`
   with `retrying: { attempt, of }`, so the user sees "trying again (2 of 3)" instead of a frozen
   bar. 403 (`refused`: Hugging Face or a proxy refused), 404 and 410 (`missing`) are not
   retried; other HTTP errors fail with `http` and the status.
6. **Verify and install.** Size and SHA-256 equal to the pin: fsync, rename `.part` to the final
   name (retried on EPERM, EBUSY and EACCES like `atomicWrite`'s transient set: antivirus locks
   new files), delete `.part.json`, record `{ bytes, mtimeMs }` as verified in `speech.json`.
   If the default model is not installed, the new model becomes the default. A download started
   from the Captions tab also becomes the default once verified (the renderer calls
   `setDefaultSpeechModel` when `downloadSpeechModel` resolves: the user picked that tier and
   agreed to its download). So once any model is downloaded the default names a downloaded one,
   and `localModel` never has to substitute silently. A mismatch deletes the .part and fails with
   `mismatch`.
7. **Cancel** aborts the request and keeps the .part: the status becomes `stopped` (Continue,
   Delete). `cancelSpeechDownload(id, true)` deletes it too. Quitting stops a download the same
   way. At startup, .part files untouched for 30 days are deleted.
8. **Remove** is refused while a transcription holds the model ("Captions are being made with this
   model. Cancel them first."); otherwise it deletes the file and any .part and updates
   `speech.json`. Removing the default model makes the first remaining installed model (catalog
   order) the default, else base.
9. **Set default** (`speech:setDefault`, Settings only) accepts only an installed model.

Measured from here: base q5_1 (59.7 MB) in 1.26 s, turbo (574 MB) in 7.3 s. At 20 Mbit/s base
takes about 24 s.

**Trust on every use** (`installedFile`): the file must be a regular file (lstat, not a link)
directly in the models folder with the verified size and modification time; otherwise it is
hashed again (base about 0.1 s, turbo about 1 s) and marked `damaged` on a mismatch. A helper
exit with error code `model`, or a crash while loading, clears the verified record, so the next
use hashes again. Only files whose pin matched are ever passed to the engine.

### 3.2 Transcription on this PC (main: `ai/transcribe.ts` + `speech/localClient.ts`)

The renderer calls the existing `window.api.transcribe(projectId, { providerId: 'local', model?,
language?, source })` over `ai:transcribe` (sender check unchanged). The pipeline is today's
`runJob` with three additions.

1. **Validate.** `validateTranscribeOptions` returns `model` when present (it must be a catalog
   id; ignored for key providers). `transcribeProject` branches on `LOCAL_TRANSCRIBER_ID` before
   `store.get` (no key). `localSpeechClient(model, { projectDir })` rejects with the shared
   sentences of `src/shared/speech/errors.ts`: `localErrorMessage('unavailable', { reason })`
   when the engine cannot run (`missing` also when the bundled speech detector model is missing or
   fails its check, §3.5: the helper reports that model as error `model` too, which would blame
   the Whisper model), `('blocked', { model, block })` when `speechModelBlock` refuses the
   model, `('no-model', { model })` when it is not installed and verified. This path never
   downloads. One job per project, as today.
2. **Decode, as today.** `soundFile` picks the microphone stem when one was kept; ffmpeg decodes
   to 16 kHz mono s16le in `os.tmpdir()/ssw-transcribe-*` (115 MB per hour).
3. **Plan parts, as today.** The client's `partLimits` are `{ maxSeconds: spec.partSeconds,
   maxBytes: Infinity }`; `planParts` cuts in quiet stretches (energy silences, `silencesOf`),
   else at fixed points with 2 s of overlap. `SSW_AI_MAX_PART_SECONDS` still applies when
   unpackaged.
4. **Each part.** With `client.input === 'wav'`, ffmpeg writes `part-N.wav`
   (`-c:a pcm_s16le -f wav`, the same `-ss`/`-t` as today's MP3 arguments): no lossy step.
   The client hashes it (SHA-256, about 20 ms for 19 MB).
   - **Cache hit** in `<project>/.cache/transcript-parts/<key>.json`, key = SHA-256 of
     (part SHA-256, model SHA-256, language asked for, `ENGINE_VERSION`): used without running
     anything; progress reports it (`resumed`).
   - **Miss:** spawn `ssw-speech transcribe --model-dir <models> --model <file> --audio part-N.wav
     --vad-model <path> --lang <code|auto> --threads <n> --low-priority --stdin-control
     --parent-pid <pid>` with the job's temporary folder as working directory and a minimal
     environment. The helper loads the model (70-120 ms for tiny and base, 290-430 ms for small,
     340 ms for turbo, 1.1 s cold), runs the speech detector on the part, transcribes it chunk by
     chunk (progress and segment lines), and prints a result line.
   - Main reads every line (`readSidecarLine`), builds the part's transcript (`localTranscript`)
     from the `segment` lines, whose word times are final (§5.2), and writes the cache file
     atomically, with the result's `language` and `language_s`.
5. **Language.** A chosen language is passed as its primary subtag (as `openai.ts` does). With
   "Detect automatically", parts run with `auto` until one's result has `language_s` ≥
   `SIDECAR.detectMinSpeech` (10 s); its language is passed to every later part. A cached part
   carries its `language` and `languageSeconds`, so a resumed job makes the same choice. '' and
   `auto` are never stored on a part or a transcript and never counted by `mergeParts`
   (`localTranscript` leaves them out).
6. **Progress.** `phase: 'loading'` until the first `ready` line, then `'transcribing'` with
   `done`/`total` parts as today plus `fraction` = (seconds of finished parts + the part's own
   fraction × its seconds) / duration, `at` = part start + the helper's `at`, `preview` = the last
   120 characters of the newest segment, and `resumed` = parts taken from the cache.
7. **Merge, as today.** `mergeParts` gives ids `t1..tn`. The transcript is `{ provider: 'local',
   model: <catalog id>, language, createdAt, segments }`. Each segment's text is its words joined
   by single spaces, so `captionTokens` always uses the real word timings. Words keep their
   punctuation ("presided,"). After a successful merge the project's `.cache/transcript-parts`
   folder is deleted.
8. **Speed learning.** For each part of at least 60 s that ran and whose `speech` line covers at
   least half of it, wall time from spawn to result ÷ part seconds is blended into `speech.json`
   `measured[id]` (0.5 old, 0.5 new) with the thread count and the build that ran, so estimates
   match this PC. Only the detected speech is transcribed, so a mostly silent part would teach a
   speed several times too fast; a speed of another build (the file roams with the profile) is
   not used, and the next one of this build replaces it.
9. **The renderer** is unchanged: `captionItems.transcribe` reads the transcript, reports "No
   speech was found in this recording" for an empty one, and commits one undo step that also
   turns captions on.

### 3.3 Time and memory, with numbers

Estimate before a run (`estimateSeconds(spec, audio, threads, measured, build)`, real code in
`estimate.ts` so the Captions tab, Settings and main's time limit agree): audio × `rtf4` ×
`threadFactor(threads)` × `WINDOWS_FACTOR` (1.3), × `COMPAT_FACTOR` (4.3) on the compatible
build, until this PC has measured itself with this build; then audio × the measured RTF scaled
by thread count (it already includes the build and Windows). Thread factors: 1 thread 3.21, 2 threads 1.78,
3 threads 1.27, 4 threads 1.0, more (4/n)^0.7 but at least 0.6. On a 4-core PC (3 threads,
factor 1.27 × 1.3 = 1.65):

| Model | 20-minute recording | 60-minute recording | Memory (`memoryNeedMB`) |
|---|---|---|---|
| Fast (tiny) | about 1½ min | about 5 min | 340 MB |
| Standard (base) | about 3 min | about 8 min | 399 MB |
| Accurate (small) | about 10 min | about 30 min | 626 MB |
| Most accurate (turbo) | about 38 min | about 1 h 53 min | 1,076 MB |

On the compatible build multiply by 4.3 (Standard on 20 minutes about 11 min, Accurate about
42 min); turbo is not offered there. Measured on Linux with 4 threads: base on 60 minutes took
215 s (3.6 min). The 1.3 factor is the wine overhead (RTF 0.105 against 0.079); real Windows is
not measured (§9).

A 60-minute recording with base: a few seconds of decoding, 6 parts of 600 s, the helper's peak
about 350 MB per part (311 MB measured on the clip plus 38 MB of samples; the single-process hour
peaked at 524 MB), the main process holds only streams, and the temporary folder holds 115 MB plus
19 MB per part.

### 3.4 Cancel, closing, crashes, stalls

- **Cancel** (`captionItems.cancelTranscription` → `ai:cancelTranscription` → `stopTranscription`):
  the job aborts; the client writes `cancel\n`, ends stdin, and kills the helper after 2 s
  (`SPEECH_TIMING.cancelGraceMs`). The job settles after the child's `close` (at most 5 s more,
  `ProjectProcesses`), then the temporary folder is removed. Measured graceful latency: 0.03 s
  (tiny under wine), 3.6 s (small, during language detection), 10.8-14.3 s on a busy machine;
  the grace period caps it at 2 s. Finished parts stay cached: Generate again continues. The exit
  of a run the app aborted (this kill, or `ProjectProcesses.stop`'s when the editor closes) is
  always `cancelled`, decided before `classifyExit`, so it never counts as a crash (no cleared
  verified record, no retry with fewer threads).
- **Closing the editor, deleting the project, quitting:** as today (`stopAnalyses`,
  `stopAllTranscriptions`); the helpers are in the same `ProjectProcesses`; `will-quit` also
  kills every helper synchronously (`stopAllSpeech`).
- **The main window's page dies** (it crashed or was killed; `attachRecorderWindow` reloads Home):
  the editor never closed, so every transcription is stopped as Cancel does
  (`stopEveryTranscription`): its result could not reach the dead page, the reloaded page has no
  Cancel for it, and Generate would be refused as "already being transcribed". Finished parts stay
  for the next Generate. Level and still analyses go on: their results are kept for the session
  and the reopened editor reuses them.
- **The app dies:** the helper sees the end of stdin (exits 0.03 s later) and also watches its
  parent (`--parent-pid`: a wait on the process handle on Windows, `PR_SET_PDEATHSIG` on Linux).
- **Exit meanings** (`classifyExit`, pure, for runs the app did not abort or kill): 0 with a
  result is ok; 2 with a cancelled line is cancelled; 1 with an error line maps its code (error
  `cpu` like an illegal instruction; `memory` fails the job with `localErrorMessage('memory')`;
  `model` with `'damaged'`; `language` with `'language'`); 0xC000001D or SIGILL switches to the
  compatible build and retries the part once; any other crash (0xC0000005, 0xC0000409,
  0xC00000FD, SIGSEGV, SIGABRT, SIGKILL from the out-of-memory killer) clears the model's
  verified record and retries the part once with half the threads; a second crash fails the job
  with `localErrorMessage('crashed', { part, parts })`, keeping the finished parts. A helper that
  cannot be started at all (the spawn's `error`: ENOENT, or EACCES, EPERM and UNKNOWN when Windows
  or an antivirus refuses it) is no crash: the job fails at once with
  `localErrorMessage('unavailable', { reason })` (`missing` or `blocked`), the model stays
  trusted and nothing is retried.
- **Stall and time limit.** whisper.cpp 1.8.3 calls its progress callback only at the top of each
  30 s window (`src/whisper.cpp` around line 7000), and one window can take minutes: turbo on the
  compatible build at 2 threads about 330 s, before language detection. So the helper's control
  thread prints a `progress` line with the latest percent and `at` whenever 15 s
  (`SIDECAR.heartbeat`) passed without a line. Main then kills the helper as `stalled` when no
  line came for 120 s (`SPEECH_TIMING.stallMs`: the process is frozen or starved), or when a part
  ran longer than max(10 min, 4 × `estimateSeconds` of the part for this build and thread count)
  (`partMinMs`, `partEstimateFactor`: whisper.cpp does not move on, which a heartbeat cannot
  show). A measured speed only lengthens that limit (when it is slower than the catalog's): one
  learned on a quieter part or another PC never kills real work. A stalled part is retried once with the same threads; a second stall
  fails the job with `localErrorMessage('stalled')`. `powerMonitor` `resume` resets both timers,
  so sleep never looks like a hang.
- **Protocol violation:** a line over 1 MB, more than 64 MB of output, or a run that ends without
  a result: the helper is killed and the job fails with `localErrorMessage('protocol')`.
- Every failure message of a local job is a sentence of `src/shared/speech/errors.ts`, thrown as
  `new Error(localErrorMessage(code, params))`; the Captions tab maps it back with
  `localErrorCode` to choose its button (§7.2).

### 3.5 The speech detector: computing it (main: `audioAnalysis.ts` + `speech/vad.ts`)

**Where it runs.** `analyzeAudio` already measures each requested source once per (path, size,
modification time). It now also runs the speech detector for **`mic`** (when `mic.m4a` exists) and
for **`mix`** only when the project folder has no `mic.m4a`; never for `system`. Levels and speech
run in parallel; the source's `AudioLevels` resolves only once the speech detector has succeeded
or definitively failed, so the preview, the export, the Clip tab and the director always read one
settled object.

**How.** ffmpeg (`-v error -nostdin -i FILE -map 0:a:0? -vn -ac 1 -ar 16000 -f f32le pipe:1`)
pipes into `ssw-speech vad --audio - --format f32le --vad-model <path> --threads 1
--low-priority --parent-pid <pid>`, in `os.tmpdir()` (the models folder may not exist). The helper
reads 300 s windows with 2 s of overlap (about 20 MB of samples plus a 15 MB model), runs Silero,
and prints one `vad` line: 1 byte per 32 ms frame (probability × 255), base64 (about 150 KB per
hour). Both processes join the `ProjectProcesses` of `audioAnalysis.ts`, so `stopAudioAnalysisFor`
stops them. Limit: 30 s + 50 ms per second of audio (the measured hour took 9 s). That line must
fit in `SIDECAR.lineMax` (`vadLineFits`: about 25,000 s, 7 hours), and the helper refuses a longer
one only after reading all the sound, so a recording whose `project.duration` is longer gets the
level detector without running anything, and a run whose levels arrive with such a length is
stopped then.

**Ranges** (`speechFromProbs`, pure): Silero's hysteresis: speech starts at p ≥ 0.5 and holds while
p ≥ 0.35; speech under 250 ms is dropped; silences under 100 ms are bridged; each range is padded
by 30 ms, clamped to the audio. Source seconds.

**Persisted** in `<project>/.cache/speech.json`: `{ version: 1, entries: { mic?: {...}, mix?: {...} } }`,
each `{ size, mtimeMs, engine: ENGINE_VERSION, model: VAD_MODEL.sha256, frame: 0.032, audio_s, n,
probs }`. Read back as untrusted input: at most 10 MB, `n` ≤ `audio_s` / 0.032 + 2, and `audio_s`
within 2 s of the level envelope's own length (`power.length × window`), so a stem a little
longer than `project.duration` is accepted. Writes are serialised per project (one promise chain
per project id: the mic and mix entries are read-modify-write) and skipped when
`running.generation(id)` changed since the run started, so a write that lands after
`stopAnalyses` never recreates `.cache` in a project folder being deleted. A second open of the
editor, even after a restart, runs nothing.

**Cost.** Levels resolve only after the detector, so the first open of a recording waits about
9 s per hour of microphone sound on the standard build (measured), about 40 s on the compatible
build (estimate), before anything that reads the levels shows: the preview's ducking, the Clip
tab, and the other team's E-04 waveform (it reads `loadAudioAnalysis`). Later opens read the
cache. The editing-wins team is told at the merge; a levels-only request for display is later.

**Two speech-to-range rules.** `transcribe` uses whisper.cpp's own `whisper_vad_segments` inside
the helper (chunking and the onset snap); the analysis uses `speechFromProbs`. Same model and
defaults (`VAD`), but windows and rounding differ, so their ranges can differ by a frame or two.
Nothing compares them; tests use tolerances.

**The model is checked** (size and SHA-256) once per session before first use; a mismatch makes
the detector unavailable for the session, and transcription on this PC (which runs the detector
inside the helper) refuses with `unavailable` (`missing`).

### 3.6 What counts as sound, per consumer (pure: `soundtrack.ts`, `voice.ts`, `speech.ts`)

**`sourceActivity`** (Remove silences, Smart speed idle, music ducking in preview and export),
same signature and null rules:

- **No heard source carries `speech`:** exactly today's code (`combineLevels` + `detectActivity`).
  This is the regression lock and the fallback.
- **Otherwise, per heard source**, joined as a union:
  - the **mic stem**: `speechActivity(speech, energy)`: the speech ranges extended by `withTails`
    into touching level-based sound (≤ 0.3 s after, ≤ 0.1 s before), joined across 0.5 s
    (`ACTIVITY.hold`), at least 0.12 s long;
  - the **system stem**: `detectActivity` (PC sound, such as a demo video, still counts);
  - the **mixed track of a recording without stems**: `speechActivity ∪ detectActivity`: never
    less than today, plus quiet speech that today's floor + 12 dB threshold loses under fan noise.
  - **Trust guard** (`trustSpeech`): a source whose speech totals under 2.0 s while its level-based
    sound totals 10 s or more is judged by its level (a narration-free typing tutorial is never
    planned as all silence).
- `combineLevels` keeps returning the one envelope for one source; speech is always read per
  source before combining.
- `soundDetector(project, analysis)` says which rule ran (`speech`, `mixed`, `guard`, `level`) for
  the Clip tab's status line: `level` when the voice source (mic stem, or the mixed track without
  stems) is heard without `speech`; `guard` only for the mic stem (a recording without stems says
  `mixed`: its sound counts either way and it has no microphone to name); null when no voice
  source is heard (the mic muted or at 0, or PC sound alone), so the line is hidden.

**Smart speed** keeps its signature; idle still needs a still picture and no input
(`smartSpeed.ts` `findIdleRanges`), so silent typing is never sped up.

**Camera director** (`speechFromLevels`): with `levels.speech`, the speech ranges joined across
`SPEECH.join` (1.0 s) and at least `SPEECH.minUtterance` (0.6 s); the input-noise filter is not
applied, so speech while typing counts (camera-director.md risk 2). No trust guard: a microphone
with typing and no voice means no talking. Without speech: today's code. `refineSpeech` with the
transcript is unchanged. `DirectorSpeech` gains `detector?: 'speech' | 'level'` for the status
line.

**Music ducking** is `musicDucking` unchanged: it now ducks under speech, not under clatter, on the
microphone stem.

### 3.7 Fallback

`speech` is left out, and every consumer behaves exactly as today, when: the helper is missing
(development without the build, Linux packages), the CPU probe or the spawn fails (Smart App
Control blocking an unsigned build, antivirus), the model is missing or its hash differs, the
helper errors, crashes, times out or prints something malformed, the recording is too long for
one detector line (about 7 hours, §3.5). Each case logs one warning,
`SpeechState.detector` says why (Settings), and the Clip tab's line says the level was used. A
definitive failure is remembered for the session (the next start tries again); a stop (editor
closed) rejects and is not cached, as today.

### 3.8 E-01 "Polish in one click" (the other team)

- `pickTranscriber(providers, speechState, remembered?)` (`src/shared/speech/transcriber.ts`,
  committed): remembered choice → On this PC with an installed model → the first key provider that
  can transcribe → On this PC not ready → null. E-01 waits until both the providers and the
  speech state are read (a null speech state means unavailable, not "still loading").
- The model is `localModel`'s: the default model, which names a downloaded model once any is
  downloaded (§3.1). The Captions tab's chips choose for the session only and do not affect E-01.
- A remembered On this PC that is not ready makes E-01 skip captions even when a key provider
  exists: the user chose that nothing be uploaded.
- E-01 transcribes only when `canTranscribeNow(choice)`; otherwise it shows
  `CAPTIONS_SKIPPED_NO_MODEL` ("Captions skipped: download a speech model in the Captions tab
  (free, 60 MB) or add an AI provider."). It never starts a download.
- It calls the existing `captionItems.transcribe(services, { providerId, model?, source:
  'auto' })`, which commits its own undo step; E-01 must not hold its single step open for the
  minutes a local job takes. Transcripts are in source seconds, so the order relative to cuts does
  not matter.
- Remove silences and the director get the speech detector through `loadAudioAnalysis` with no API
  change.
- E-01 can import `transcriber.ts` once this contracts commit is on main (behaviour-neutral; see
  Integration).

---

## 4. Data model and migration

**`project.json`: schema v2 unchanged, no migration.**

- `Transcript.provider` widens to `AiProviderKind | 'local'` (`src/shared/types.ts`, one line);
  `captionData.ts` `KINDS` gains `'local'`, so `readTranscript` keeps it. `Transcript.model` holds
  the catalog id; the UI shows the catalog name.
- `CaptionSegment` and `CaptionWord` are unchanged. Scripts without spaces (Chinese, Japanese)
  get one word per segment (karaoke lights the whole caption): a known limit.
- An older Flown opening a local transcript shows "by OpenAI" (`readTranscript` maps unknown
  providers to `'openai'`); captions and word times are intact.

**Project folder (new, derived, safe to delete, ignored by older versions):**

| File | What |
|---|---|
| `.cache/speech.json` | speech detector probabilities per source (§3.5), about 150 KB per hour per source |
| `.cache/transcript-parts/<key>.json` | `{ version: 1, model, modelSha256, language, languageSeconds, engine, partSha256, transcript: RawTranscript }`, one per finished part (`language` '' when nothing was detected); deleted after a successful merge and with the project |

Both are read back with the same validators as live output, with size caps.

**userData (`%APPDATA%\Flown`, the Roaming profile; the requirement says userData, so the models
stay there: risk 21):**

| File | What |
|---|---|
| `speech-models/<file>` | an installed model, exactly the pinned bytes |
| `speech-models/<file>.part`, `<file>.part.json` | a download that stopped; deleted after 30 days untouched |
| `speech-models/speech.json` | `{ version: 1, defaultModel, verified: { [id]: { bytes, mtimeMs } }, measured: { [id]: { rtf, threads, build } } }`, atomic writes; anything malformed falls back to defaults (base, nothing verified, nothing measured); an unknown id becomes the default; `rtf` must be finite in 0.005..20 and `build` one of the helper's builds (a measured speed applies only to its build). The default changes only by the rules of §3.1 (Settings, a download from the Captions tab, the first download, removing the default) |

Unknown files in the folder are ignored and never loaded. `app-settings.json`, prefs and
`ai-providers.json` are untouched; stored provider ids match `/^ai[a-z0-9]{1,30}$/`
(`keyStore.ts`), so `'local'` can never collide.

**In memory and over IPC (frozen):**

- `AudioLevels.speech?: Range[]` (`loudness.ts`): source seconds, sorted, separate; structured-
  cloned with the levels over `export:analyzeAudio`.
- `SpeechModelStatus` `downloading` gains `retrying?: { attempt, of }`; `SpeechDownloadError`
  gains `refused` (403).
- `TranscribeOptions.model?: string`; `TranscribeProgress.phase` gains `'loading'`, plus
  `fraction?`, `at?`, `preview?`, `resumed?` (cloud providers send none, so the UI keeps "Part X of
  Y" for them).
- The catalog is compiled into the app; there is no remote catalog (NW-15 later must keep the
  SHA-256 pins).

Old projects and settings load unchanged; a project without `.cache` runs the detector on first
need; a project without stems uses the union rule and never sees less sound than before.

---

## 5. Processes, IPC and security

### 5.1 IPC (`SPEECH_CHANNELS`, `src/shared/api/speech.ts`)

| Channel | Kind | Payload → result | Sender check |
|---|---|---|---|
| `speech:state` | invoke | → `SpeechState` (the first call runs the CPU probe) | `isAppUrl(senderFrame.url)` |
| `speech:download` | invoke | catalog id → void once installed and verified; rejects with a message (`Cancelled.` when cancelled) | same |
| `speech:cancelDownload` | invoke | (id, discard: boolean) → void | same |
| `speech:remove` | invoke | id → void; rejects while in use | same |
| `speech:setDefault` | invoke | id → void; rejects unless the model is installed | same |
| `speech:showFolder` | invoke | → void (`shell.openPath` of the fixed models folder) | same |
| `speech:changed` | send | main → app windows: `SpeechState`, on change, at most 4 a second | |
| `ai:transcribe`, `ai:cancelTranscription`, `ai:transcribeProgress` | unchanged | `providerId: 'local'`, `model?`; progress fields of §4 | unchanged (`fromApp`) |
| `brand:notices` | invoke | → the notices text (fixed file, at most 2 MB) | `isAppUrl` (committed) |
| `export:analyzeAudio` | invoke | unchanged; levels may carry `speech` | **added**: `isAppUrl` (it now starts the helper) |
| `projects:detectStill`, `projects:stopAnalysis` | invoke | unchanged | **added**: `isAppUrl` (hardening in passing) |

The renderer passes catalog ids and project ids only, never a path or an address. Every id is
checked with `speechModel()`, booleans with `=== true`.

### 5.2 The sidecar protocol (frozen: `src/shared/speech/protocol.ts`; `native/speech`)

**Subcommands and arguments** (read with `args_os`, so Windows arguments are UTF-16 clean):

- `ssw-speech cpu`
- `ssw-speech vad --vad-model P --audio <wav|-> [--format f32le] [--threads 1] [--low-priority]
  [--parent-pid N]`
- `ssw-speech transcribe --model-dir D --model F --audio W --vad-model P [--lang auto|xx]
  [--threads N] [--max-chunk S] [--low-priority] [--stdin-control] [--parent-pid N]`
  (`--max-chunk`, 1..29.5 s, default `SIDECAR.maxChunk`: per model since §14.3)
- Debug only: `--dtw auto|off|<preset>`, `--beam N`, `--prompt S`, `--verbose`.
- `F` must match `[A-Za-z0-9._-]+`; Rust joins it to `D`, so there is no path traversal. Models and
  the VAD model are opened by Rust (`std::fs::File`, Unicode paths) and handed to whisper.cpp
  through `whisper_model_loader` (`whisper_init_with_params_no_state`,
  `whisper_vad_init_with_params`), because MinGW whisper.cpp opens paths with a narrow
  `std::ifstream` (wide paths only under `_MSC_VER`).
- Audio: WAV 16 kHz mono s16 or f32 (anything else is error `audio`), or `-` with raw f32le on
  stdin (the speech detector).

**stdout**, one JSON object per line, UTF-8 (lossy), each line at most 1 MB
(`SIDECAR.lineMax`), at most 64 MB in all:

```
{"type":"cpu","sse42":b,"avx":b,"avx2":b,"fma":b,"f16c":b,"bmi2":b,"logical":n}
{"type":"vad","audio_s":n,"frame":0.032,"n":n,"probs":"<base64 of n bytes>","detect_ms":n}
{"type":"ready","model":"base","multilingual":true,"dtw":"BASE","build":"standard","system":"…"}
{"type":"speech","segments":[[s,e],…]}
{"type":"progress","percent":0..100,"at":s}
{"type":"segment","start":s,"end":s,"text":"…","words":[{"text":"…","start":s,"end":s,"prob":p}]}
{"type":"result","language":"en","language_s":n,"duration":s,"timing":{"load_ms":n,"vad_ms":n,"asr_ms":n,"rtf":n,"peak_rss_mb":n}}
{"type":"cancelled","done_until":s}
{"type":"error","code":"args|model|audio|language|memory|cpu|internal","message":"…"}
```

Times are seconds from the start of the audio, three decimals. Exit codes: 0 ok, 1 error,
2 cancelled. With `--stdin-control`, a `cancel` line or the end of stdin cancels at the next
checkpoint. With `--parent-pid N`, a process N already gone (or, on Windows, ending) cancels at
once with its `cancelled` line; on Linux N must be the helper's parent (else error `args`), whose
death kills the helper (`PR_SET_PDEATHSIG`). In `transcribe`, error `model` always means the
Whisper model: a `--vad-model` that cannot be loaded is error `args` (main passes only the
pin-checked detector model, §3.1). `segment` lines are printed after each chunk (whisper.cpp 1.8.3's segment callback
passes a wrong count with DTW and is not used) and carry **final word times**: the result line
carries no words, so the segment lines are everything main gets, and nothing changes a word
after its line is printed. While `transcribe` works, its control thread prints a `progress` line
with the latest percent and `at` whenever `SIDECAR.heartbeat` (15 s) passed without a line
(§3.4). With `--lang auto`, the language is detected once before the first chunk (§2.5) and
reported with `language_s`. Peak memory comes from `K32GetProcessMemoryInfo` (kernel32; not
psapi) on Windows, `getrusage` elsewhere.

**Word forming** (`words.rs`), per chunk, before its segment lines are printed. Raw words: tokens
with id below `whisper_token_eot`; a new word starts at a token whose bytes begin with a space;
bytes are joined and decoded as UTF-8 once (a token can split a code point); `t_dtw`
(centiseconds) marks about the end of a token; the word ends at the `t_dtw` of its last letter or
digit token (punctuation tokens come late: +0.7-1.2 s); it starts at the previous word's end or
the segment's t0. Then the refinements, with state carried from chunk to chunk through the run:

1. **Pull-in:** a start more than max(0.3 s, 2 × min(0.7, median)) before the word's end moves to
   that distance, where the median is taken over the raw word lengths of this chunk and every
   earlier chunk of the run (the first chunk seeds it), never over words not yet transcribed.
2. **Onset snap:** a speech onset of the part's speech ranges (the `speech` line) inside
   (start, end − 50 ms) moves the start to it.
3. **Monotonic:** a start is never before the previous word's end, including the last word of the
   previous chunk (`last_end` is carried across chunk joins); an end is never before its start.

prob = mean token probability. On the spike's own segment lines this gives base q5_1 word starts
45 / 145 ms / 92.4 % within 200 ms (§2.1), equal to the spike's whole-run refinement.

### 5.3 Spawning and process control (main: `src/main/speech/helper.ts`)

- `spawn(exe, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd, env })`
  with `env` reduced to what the C runtime needs (`SystemRoot`, `TEMP`, `TMP`, `PATH` on Windows;
  `PATH`, `LANG` elsewhere).
- Paths: packaged `process.resourcesPath/native/ssw-speech.exe`, `…/native/ssw-speech-compat.exe`,
  `…/speech/ggml-silero-v6.2.0.bin`; development `native/bin/ssw-speech[.exe]` and the
  repository's `resources/speech/`; `SSW_SPEECH_HELPER` overrides the helper only when the app is
  not packaged.
- stderr is kept (last 4 KB) for logs only. stdout is split by `\n` with the caps above; every line
  goes through `readSidecarLine`; invalid lines are dropped; overflow kills the helper.
- Inside the helper (`guard.rs`): `--low-priority`; a parent watch thread; on Windows
  `SetProcessMitigationPolicy` for extension points (disabled) and image loads (no remote, no
  low-label, prefer System32), a failure logged and ignored (wine ignores them); dynamic code
  prohibition and strict handle checks are deferred with MicrosoftSignedOnly (§11): wine cannot
  test them, and strict handle checks turn any stray invalid handle into a crash on real Windows
  only. "Mitigations active" is on the manual Windows checklist (§10.5). `PR_SET_NO_NEW_PRIVS`
  and `PR_SET_PDEATHSIG` on Linux. The helper writes no files and opens no sockets.
- Working folders: the job's temporary folder for `transcribe`; `os.tmpdir()` for `cpu` and
  `vad`.

### 5.4 Security checklist

- **No downloaded code.** Models are data, loaded only after their pinned SHA-256 matched,
  re-checked on size or time changes and after crashes. The helper and the speech detector model
  ship in the signed installer. Downloads go only to https Hugging Face hosts; the test hook
  `SSW_SPEECH_MODEL_BASE_URL` (http://127.0.0.1 allowed) and `SSW_SPEECH_HELPER` are ignored when
  packaged.
- **Sandbox and IPC.** The renderer stays sandboxed with its CSP (no network: it makes no request
  for this feature). Every new handler checks the sender; arguments are ids only; the main process
  never builds a path from renderer input.
- **The parser surface.** whisper.cpp parses model files natively: only pinned files reach it; the
  helper runs with process mitigations, below-normal priority, no shell, a minimal environment, no
  file writes and no network. A same-user attacker who swaps a file between the hash and the load
  already owns the account.
- **Fuses.** The helper and the model live outside app.asar (extraResources), so
  `onlyLoadAppFromAsar` and `runAsNode: false` are unaffected (no Node script is forked).
- **Temporary data.** The decoded PCM and part WAVs live in `os.tmpdir()/ssw-transcribe-*` as
  today and are swept; unfinished transcript parts live in the project's `.cache` (§9 risk 18).

---

## 6. Packaging and build

### 6.1 `scripts/build-native.mjs` (workstream A)

- After `ssw-capture.exe`, build `native/speech` for `x86_64-pc-windows-gnu` twice, with separate
  `CARGO_TARGET_DIR`s (`native/speech/target/standard`, `…/compat`; whisper-rs-sys's build script
  ignores changed environment variables), environment as in `native/speech/README.md`
  (posix MinGW, `CMAKE_PROJECT_INCLUDE`, the forced-include header, `GGML_*` flags). Output:
  `native/bin/ssw-speech.exe`, `native/bin/ssw-speech-compat.exe`. 32-40 s each from clean.
- `--speech-host` (and `npm run build:speech-host`): the host build into `native/bin/ssw-speech`
  (59 s from clean on Linux here).
- Missing cmake, libclang or the posix MinGW warns and skips the speech helpers (captions offer
  keys only; the detector falls back), unless `--require` or `SSW_REQUIRE_NATIVE=1`, which release
  builds set. On a Windows build host the speech helpers are not built; usable ones already in
  `native/bin` (built on Linux or macOS) are reused with a warning, also under `--require`.

### 6.2 `electron-builder.config.cjs` and `scripts/lib/packaging.cjs`

`extraResources` gains, in directory form (so the signing transformer applies):

- `{ from: 'native/bin', to: 'native', filter: ['ssw-speech.exe', 'ssw-speech-compat.exe'] }`
  (beside the capture helper's entry);
- `{ from: 'resources/speech', to: 'speech', filter: ['ggml-silero-v6.2.0.bin', 'MODEL.md'] }`;
- `{ from: 'resources', to: '.', filter: ['THIRD_PARTY_NOTICES.txt'] }`.

Nothing joins `asarUnpack` or app.asar; `SIGN_EXTS` is unchanged (every `.exe` is signed already).
`packaging.cjs` gains `speechHelpers()`, `speechResources()` and `speechHelperStatus()` (a helper
that is not a complete x64 PE is left out with a warning, never fatal, like the capture helper).

### 6.3 `predist.mjs`, `verify-dist.mjs`, `pe.cjs`

- `pe.cjs` gains `readImports(buf): string[]`.
- `verify-dist` section 4b: both helpers are x64 PEs whose imports are a subset of {KERNEL32,
  ADVAPI32, msvcrt, ntdll, api-ms-win-core-synch-l1-2-0, bcryptprimitives} (Rust 1.78 and newer
  seed `HashMap` from `ProcessPrng` in bcryptprimitives.dll, a system DLL: checked here with a
  release `HashMap` build for x86_64-pc-windows-gnu; peak memory uses `K32GetProcessMemoryInfo`
  from kernel32, so psapi.dll never appears); the speech detector model's SHA-256 equals
  `VAD_MODEL`; `THIRD_PARTY_NOTICES.txt` exists, is at least 10 KB and names whisper.cpp, ggml,
  Silero VAD, OpenAI Whisper, mingw-w64, FFmpeg, Electron, React and MediaPipe. It budgets the
  **speech payload itself** (both exes, the detector model and MODEL.md, the notices file): it
  prints it raw and compressed with Node's brotli (quality 11, 16 MB window; measured here
  1,799,771 B for the standard exe and the model, against 1,759,208 B with xz) and fails above
  3.5 MB compressed or 10 MB installed. It prints the whole installer's size but no longer
  compares it with a baseline, so the editing-wins merge cannot trip it.
- `predist` builds the helpers (required for releases), checks the model hash and that the notices
  file is fresh (`scripts/notices.mjs --check`; without `cargo` the committed Rust crates' section
  is kept with a warning and the rest is checked, except under `SSW_REQUIRE_NATIVE=1`).

### 6.4 Installer growth

| Part | Installed | Compressed (xz -9e, about what NSIS LZMA gives) |
|---|---|---|
| `ssw-speech.exe` | 3,585,024 B (measured) | 1,007,852 B (measured) |
| `ssw-speech-compat.exe` | about 3.5 MB (estimate: same code, no SIMD paths) | about 1.0 MB (estimate) |
| `ggml-silero-v6.2.0.bin` + MODEL.md | 885,098 B + 1 KB | 752,208 B (measured) |
| `THIRD_PARTY_NOTICES.txt` | about 150 KB (estimate) | about 40 KB |
| **Total** | **about 8.1 MB** | **about 2.8 MB** (116.8 → about 119.6 MB) |

The exe and the model together measured 1,759,208 B with tar | xz (1,799,771 B with brotli 11).
Budgets enforced by verify-dist on the speech payload: 3.5 MB compressed (brotli), 10 MB
installed.

### 6.5 Toolchain

Rust 1.88 or newer (1.97 here), cmake 3.28, clang/libclang 18 (bindgen), mingw-w64 with the posix
thread model (`x86_64-w64-mingw32-gcc-posix`, `g++-posix`). `docs/BUILDING.md` lists them. CI caches
`~/.cargo`, `native/speech/target` and `.cache/test-speech`.

---

## 7. UX and copy

The sentences below are exact. The ones the main process produces (a local job's failures, why
a model is not offered, why the engine is unavailable) are the frozen `src/shared/speech/errors.ts`
(`localErrorMessage`, `modelBlockReason`, `UNAVAILABLE_REASONS`, `tierLabel`), used by both sides;
the renderer's own copy lives in `src/shared/speech/speechCopy.ts` (`SPEECH_COPY`, workstream C),
like `notesCopy.ts` and `directorCopy.ts`. **Naming:** in the Captions tab a model is named by its
tier first and its model name once in brackets, "Standard (Whisper base)", and every action is
phrased by tier ("Try Standard", [Use Standard]); bare model names appear only in Settings and the
done summary.

### 7.1 Captions tab: the transcriber

- **Loading.** Until both the providers and the speech state are read, the section shows only
  "Checking this PC…" (`data-state="checking"`): the first `getSpeechState` runs the CPU probe,
  which can take seconds while an antivirus scans the new exe. The renderer keeps "loading"
  separate from "failed": a rejected read (no handler, an error) counts as unavailable (`failed`)
  and is logged. Nothing else (no key block, no consent card) shows meanwhile.
- The "Provider" select (aria-label "Transcription provider", unchanged) lists **"On this PC (free,
  private)"** first whenever the engine is available, then the key providers as today
  (`providerLabel`). Providers that cannot transcribe are never listed.
- With no key provider that can transcribe, the select is replaced by a static line: "Captions are
  made on this PC: free, and nothing is uploaded." (no link here: the cloud path appears once,
  under the consent card, §7.2).
- Engine unavailable: the option is left out and a hint reads
  `localErrorMessage('unavailable', { reason })`: "Captions on this PC are not available here:
  {reason}." (`UNAVAILABLE_REASONS`: `missing` "part of Flown is missing; reinstall it to get them
  back"; `cpu` "this PC's processor cannot run the speech model"; `blocked` "Windows or an
  antivirus blocked the speech engine"; `failed` "the speech engine did not start"). Today's key
  block then stays exactly as it is: it is the only way.
- **Default** (`pickTranscriber` with the session's remembered choice): §3.8. Existing key users see
  no change until they pick it or install a model.
- With On this PC chosen, a **"Quality"** chip row (`data-testid="local-model"`, the Chips control,
  a radio group named "Quality"): "Fast", "Standard", "Accurate", and "Most accurate (slow)" only
  when Whisper large-v3 turbo is downloaded and allowed here. Each chip's **visible label** carries
  its state: "Fast · 44 MB", "Standard · Downloaded", "Accurate · 190 MB" (accessible names "Fast,
  44 megabyte download", "Standard, downloaded"); nothing depends on a title tooltip. A chip is
  the choice **for this app session only** (kept like `remembered.provider`, starting at
  `defaultModel`); it never calls `setDefaultSpeechModel`. A choice the chips no longer list (Most
  accurate removed in Settings, or a damaged Most accurate default) falls back to the default
  model, else `localModel`'s pick, else Standard, so one listed chip is always checked
  (`speechState.offered`, also kept while its own Download again runs). Under the chips: the chosen tier's
  purpose ("Quickest; for slower PCs. Less accurate with accents and noise." / "Recommended for
  most recordings." / "More accurate, also for other languages; about 3.7 times slower than
  Standard." / "Most accurate, but slower than playing the recording on most PCs."), then
  `data-testid="local-estimate"`: "Downloaded · about 3 min for this recording" or "190 MB
  download · about 10 min for this recording", and the link "Manage speech models…" (opens
  Settings at `speech`).
- **Slow PCs.** On the compatible build a status line under the chips: "This PC's processor runs
  the speech engine in a slower mode, so captions take longer. Fast is suggested." For any tier
  whose estimate is longer than the recording: "Slower than playing the recording: about
  {estimate} for this one."
- **Languages.** When a spoken language other than English is chosen with Fast or Standard, before
  Generate: "Smaller models make more mistakes in languages other than English. If accuracy
  matters, choose Accurate."
- "Spoken language" and "Sound" are unchanged.

### 7.2 States and copy (`data-testid="local-captions"`, `data-state`)

`{Tier}` is the chosen chip's tier and `{Tier (Model)}` its `tierLabel`; sizes are `sizeWords`.

| `data-state` | Copy and controls |
|---|---|
| `checking` | "Checking this PC…" (§7.1). |
| `no-sound` | The recording has no sound: today's "This recording has no sound to transcribe." No download is offered. |
| `needs-model` | Title "Make captions on this PC". Body: "Free and private: the sound never leaves this PC, and no key or account is needed. Flown first downloads the speech model for {Tier (Model)} once ({size}, from Hugging Face) and checks it before use. Then this {duration} recording takes {estimate}." The only primary button: "Download {size} and make captions" (accessible name "Download {Tier} ({Model}), {size in words}, and make captions"). **When another model is downloaded** (`localModel`), a secondary button "Make them now with {its tier} (downloaded)" (`data-testid="local-use-installed"`; selects that chip and starts). Small print, plain text (no link: no open-URL channel): "Whisper by OpenAI, MIT licence · huggingface.co/ggerganov/whisper.cpp". **No key provider that can transcribe:** today's key block is not shown; under the card one secondary link, "Prefer the cloud? Use your own OpenAI or Gemini key…" (opens Settings at `ai`); "Your providers could not be read: {error}" and [Check again] appear only when reading the providers failed. **Blocked download:** not enough space: the button is `aria-disabled="true"` (it keeps focus) and a visible line linked by `aria-describedby` says "Not enough free space: the model needs {size} and the disk has {free} free." with [Check again]; offline (`navigator.onLine` false, checked before the request): "This PC is offline. Connect to download the speech model ({size}); once downloaded, captions work offline."; another model downloading or being checked (the main process downloads one at a time): "{Tier (Model)} is downloading, and one speech model downloads at a time: download {Tier} once it is done.", which also blocks [Continue download and make captions], [Try again] and [Download again]. |
| `downloading` | "Downloading {Tier (Model)}… 21 of 60 MB · 4.2 MB/s · about 10 s left", a bar, [Cancel]. Note: "Captions start as soon as it is here. You can keep editing." While `retrying`: "The connection dropped: trying again ({attempt} of {of})…". |
| `verifying` | "Checking the download…". Focus moves to the card's heading (`tabIndex=-1`) as Cancel disappears, never to the body. Then the model becomes the default (§3.1) and captions start by themselves (the click asked for captions). |
| `stopped` | "Download stopped at 21 of 60 MB." [Continue download and make captions] [Delete the 21 MB downloaded]. |
| `download-failed` (role=alert) | "The speech model could not be downloaded: {reason}". `network`: "Flown could not reach huggingface.co. Check the internet connection; the {received} already here are kept." (nothing received: "Flown could not reach huggingface.co. Check the internet connection.") [Try again]. `http`: "Hugging Face answered with an error (HTTP {status}). Try again later." [Try again]. `refused`: "Hugging Face or your network refused the download (HTTP 403). A proxy or firewall may be blocking it." [Try again]. `missing`: "{Tier (Model)} is no longer where this version of Flown downloads it from. Updating Flown fixes this." [Choose another tier] (focuses the chips), plus [Use an AI provider instead] when a key provider can transcribe. `mismatch`: "The downloaded file was not the expected one, so it was deleted and not used." [Try again]. `disk`: "Not enough free space: the model needs {size} and the disk has {free} free." [Check again] while the disk is still too full; once it has room (or its free space cannot be read) "There was not enough free space: the model needs {size}. The disk now has {free} free." [Try again], the same button, so focus stays on it (the main process keeps the failure until a new download starts). `other`: "{message}" [Try again]. |
| `ready` | The chips, language, sound, [Generate captions]. Hint (replacing the billing sentence for local): "Runs on this PC: nothing is uploaded and it costs nothing." Memory warning (role=status), only for Accurate and Most accurate when free memory < `memoryNeedMB`: "{Tier} needs about {need} of free memory; this PC has {free} free right now. Close other apps or choose {quicker tier}." |
| `running` | Phase: "Loading the speech model…" / "Preparing the sound…" / "Making captions on this PC… {at} of {duration}" / "Finishing…" / "Stopping…"; then "about {left} left" or "Working out the time left…"; a bar; "Heard: “{preview}”" (one muted line, ellipsis); after a resume "Continuing: 3 of 6 parts were already done."; note "You can keep editing. Closing this recording stops the captions; Generate captions continues from there next time." [Cancel]. `data-part` and `data-parts` carry the part in progress (1-based) and the count, for tests. The visible block has no `role=status` or `aria-live` (it changes every second); a hidden announcer speaks phase changes and every 25 % (§7.7). |
| `cancelled` | After Cancel, when at least one part finished: "Stopped. 3 of 6 parts are kept: Generate captions continues from there." above the `ready` controls; with none finished, or with another tier or spoken language chosen than the stopped run's (the part cache is keyed by both), plain `ready`. |
| `done` | Right after a run (this session): "{n} captions made on this PC with {Model} ({language}, detected) in {took}. Nothing was uploaded." with the link "Not {language}?" (opens the form with Spoken language focused) only when the language was detected; with a chosen language "({language})" and no link. Reopened later (the transcript stores neither detection nor time): "{n} captions made on this PC with {Model} ({language})." On Fast or Standard with a language other than English: "Smaller models make more mistakes in languages other than English. If these captions need many fixes, try Accurate." |
| `error` (role=alert, inside the existing "Captions could not be made: {message}" box) | `{message}` is the main process's `localErrorMessage`; the button comes from `localErrorCode(message)`: `damaged` → [Download again ({size})] (downloads the same model, then makes captions); `memory` → [Use {quicker tier}] (selects that chip; none for Fast); `crashed`, `stalled` → [Generate captions again]; `no-model` → back to `needs-model`; `unavailable`, `protocol`, `language`, `blocked` → none. Any other message (`null`) is shown as today ("No speech was found in this recording", "This recording has no sound to transcribe."). |

- **Cloud errors** gain: "Or make them on this PC: free, and nothing is uploaded." [Use On this PC]
  (switches the choice; never downloads).
- **The "Generate captions" command** waits, as today for the providers, until both the providers
  and the speech state are known; then it starts at once only when the chosen transcriber can
  transcribe now; otherwise it opens the tab and focuses the download button (focusable even when
  `aria-disabled`), or "Add an AI provider" when On this PC is unavailable. It never starts a
  download.
- **Intro** (`CaptionsIntro`): "Captions put what you say on the video, so it is understood with
  the sound off. Flown makes them from the recording's sound: free on this PC, or with an AI
  provider of your choice. You can then fix the text, restyle them, translate them and export them
  as subtitles."

### 7.3 Settings › Captions on this PC (`SpeechModelsSection`, section id `speech`)

Between "AI providers" and "About"; `ssw:open-settings` accepts `'speech'`;
`data-testid="speech-models"`, heading `h3#settings-speech-title` "Captions on this PC".
`SettingsSection` gains `'speech'` and `SettingsButton` stops coercing it to `'ai'`;
`SpeechModelsSection` takes a `reveal` prop like `AboutSection` and, when opened at `speech`,
scrolls into view and focuses its heading (`AiProvidersSection`'s autofocus on "+ Add provider"
applies only when opened at `ai`).

- Lead: "Make captions without an API key. The speech model runs on this PC, so the sound never
  leaves it and nothing is billed. Each model is downloaded once from Hugging Face and checked
  before it is used."
- A radio group "Model used for new captions", one row per model (`data-model`, `data-state`);
  the radio is enabled only on downloaded rows (the default only ever names a downloaded model
  once one exists, §3.1); a row that is not downloaded shows its [Download {size}] instead. Each
  row: name and tier ("Whisper base · Standard") with badges "Recommended", "Downloaded"; the line
  "{size} download · about {per10} per 10 minutes of recording on this PC · about {memory} of
  memory" ("measured on this PC" once measured); the purpose ("Quickest; for slower PCs. Less
  accurate with accents and noise." / "Recommended for most recordings." / "More accurate, also
  for other languages; about 3.7 times slower than Standard." / "Most accurate, but slower than
  real time on most PCs."); the licence line "Whisper by OpenAI (MIT licence), converted by the
  whisper.cpp project · huggingface.co/ggerganov/whisper.cpp (5359861)".
- Row actions: [Download {size}] / "Downloading… 34 % · 20 of 60 MB · 4.2 MB/s" [Cancel] /
  "Stopped at 20 of 60 MB" [Continue] [Delete] / "Checking…" / "Downloaded" [Remove] / "Damaged"
  [Download again] / "Download failed: {reason}" with the reasons and buttons of §7.2. While
  retrying: "The connection dropped: trying again (2 of 3)…". Remove asks inline, in the AI
  providers' pattern: "Remove Whisper small? It frees 190 MB. Captions you already made stay."
  [Remove] [Cancel] (Esc cancels); while in use Remove is `aria-disabled` with the visible line
  "In use: captions are being made with it." A blocked row (`allowed: false`) shows its `reason`
  (`modelBlockReason`) as visible text linked by `aria-describedby` to the `aria-disabled`
  Download button: "Needs about 1.1 GB of memory and a PC with 8 GB in all; this one has 4 GB." or
  "Too slow for this PC's processor: it needs one with AVX2 (most PCs from 2013 on)." 
- Engine line: "Speech engine: ready" / "ready (compatible mode for this processor: slower)" /
  "not available ({reason})".
- Detector line: "Speech detector: built in (Silero VAD). Remove silences, Smart speed, music
  ducking and the camera director listen for speech, so typing and fans do not count as sound." or
  "Speech detector: not available on this PC ({reason}), so these use sound levels instead."
- Footer: "Speech models use {used} · {free} free on this drive" [Show folder].
- **AI providers** intro (AiProvidersSection) keeps its sentences and adds: "No key? Captions can
  also be made on this PC, free and offline (see Captions on this PC below)."

### 7.4 Clip tab, Audio tab, director

- Clip › Silences, a status line `data-testid="silence-detector"` with `data-detector` =
  `speech | mixed | guard | level`:
  - `speech`: "Listening for your voice: typing, clicks and room noise on the microphone do not
    count. Sound your PC plays still counts." (the second sentence only with a system stem);
  - `mixed`: "Listening for speech and any other sound: this recording has no separate microphone
    track.";
  - `guard`: "No speech was found on the microphone, so sound levels are used.";
  - `level`: "Listening for any sound: the speech detector is not available, so typing counts as
    sound too.";
  - no line when no voice source is heard (the microphone muted or at 0, or PC sound alone): every
    sound counts as before and no detector ran.
- Silences hint (voice case): "Cuts or speeds up the pauses in your talking, keeping a little of
  the silence next to the sound so no word is clipped." Smart speed hint (voice case): "…the
  picture stays still, you are not talking and your PC plays no sound, and you did not move,
  click, scroll or type."
- Audio › music ducking hint: "How far the music dips while you talk or your PC plays sound."
- Director (`directorCopy.ts`): the mic line stays "Listening to your microphone."; mixed track
  with speech: "Listening for voices in the recording's sound (no separate microphone): voices
  from your PC count as talking."

### 7.5 About › Third-party notices

About lives inside the Settings modal, and a second `useModalFocus` dialog would fight it (both
register window listeners: Settings' Esc handler, registered first, would close Settings, and the
two Tab traps would compete). So the notices open **inline** (`NoticesPanel`): a button
"Third-party notices" (`aria-expanded`, `aria-controls`) reveals, below it, a read-only
scrollable `pre` region (role=document, `tabIndex=0`, labelled "Third-party notices", at most
half the window high), loaded on first open; focus moves into the region; Esc inside it collapses
it in its own `onKeyDown` (`preventDefault`, so Settings stays open) and focus returns to the
button. Failure: "The third-party notices could not be shown: {message}".

### 7.6 Keep working while it runs

- The job runs in main; the renderer job store is module-level, so every tab, the preview, trims
  and export keep working.
- The Captions tab button carries a small ring (`data-testid="captions-job-badge"`,
  `data-phase="download|verify|job"`, `aria-hidden="true"`, title "Captions: downloading the speech
  model, 35 %" / "Captions: checking the download" / "Captions: making captions, 42 %") while the
  captions download **or** job of this project runs (`Inspector.tsx`, about 10 lines). The tab
  button's accessible name does not change; progress is announced through the hidden live region
  at 25 % steps.
- When a job finishes while another tab is open, the editor's notice says "Captions ready: {n}
  captions made on this PC in {took}. Undo removes them." or "Captions could not be made: open the
  Captions tab for details." When the download started from the Captions tab fails, stops or is
  deleted on a mismatch while another tab is open: "The speech model could not be downloaded:
  open the Captions tab for details."
- **Download, then captions** (`speechState.ts`): the pending "then make captions" intent is kept
  in a module-level store keyed by project id. When the download resolves, the model becomes the
  default (§3.1); captions start only if that project's editor is still open and the intent still
  pending. Closing that editor drops the intent (`stopAnalyses` has run, and nothing would stop a
  job started then) but lets the download finish; the next open shows `ready` and never starts
  captions by itself. Captions never start for another project. When the project already has
  captions, the click on a button that downloads and then makes captions asks the replace
  question of every Regenerate first; a yes carries to the end of the download.
- An export started meanwhile runs at normal priority; the running state may show "Exporting now
  slows the captions down." (cut first if time is short).

### 7.7 Accessibility

- Bars are `role="progressbar"` with min, max, now and a text ("42 percent, about 3 minutes left");
  names "Speech model download" and "Captions made".
- Phase changes go to a visually hidden `aria-live="polite"` span, updated on a phase change and
  every 25 %; the visible running and downloading blocks carry no `role=status` or `aria-live`
  (today's running block's `role=status aria-live=polite` is removed), so the "Heard:" line, the
  time left and the download figures are not announced continuously. The hidden span uses a
  shared `.sr-only` class added to `styles.css` (additive; `.director-live` stays as it is). Errors
  are `role="alert"`.
- Buttons that download name the model and size; Remove names what it frees ("Remove Whisper small,
  frees 190 megabytes").
- Focus never falls to the body when a focused button disappears: Download → Cancel → (verifying)
  the card's heading (`tabIndex=-1`) → Cancel (running) → (done) Regenerate captions…; an inline
  Remove question takes focus, Esc cancels it. In Settings a row whose buttons change passes the
  focus to its new action (Download → Cancel → Continue …), to its status line while "Checking…"
  (`tabIndex=-1`), and after a confirmed Remove to the row's Remove, then its Download.
- A control that cannot act now is `aria-disabled="true"` (still focusable, so the "Generate
  captions" command can focus it), with its reason as visible text linked by `aria-describedby`;
  never a `disabled` button with the reason in a title.
- States are written in text, never colour alone; the busy bar and the ring respect
  `prefers-reduced-motion`; all copy wraps at 200 % zoom.

---

## 8. Licences and notices

| Component | Licence | Shipped | What is required |
|---|---|---|---|
| whisper.cpp 1.8.3, ggml 0.9.5 | MIT, "Copyright (c) 2023-2024 The ggml authors" | compiled into both helpers | the notice in THIRD_PARTY_NOTICES.txt |
| whisper-rs-sys 0.15.0 | Unlicense | compiled in | none; credited |
| Other Rust crates of both helpers (`cargo metadata`; the capture helper's `windows` crate, MIT/Apache-2.0) | as declared | compiled in | their licence texts |
| Rust standard library (std, core, alloc and the crates the toolchain builds into it) | MIT OR Apache-2.0, "Copyright (c) The Rust Project Developers" | statically linked into all three helpers | the notice (hand-written; `cargo metadata` does not list it) |
| mingw-w64 runtime (winpthreads) | MIT-style / ZPL | statically linked | its notice |
| libstdc++, libgcc | GPL-3.0 with the GCC Runtime Library Exception | statically linked | the exception permits it; noted |
| Silero VAD v6.2.0 (ggml conversion, ggml-org/whisper-vad@9ffd54a1) | MIT, "Copyright (c) 2020-present Silero Team" | in the installer | the notice, the release and the file's SHA-256 (also resources/speech/MODEL.md) |
| OpenAI Whisper weights (ggml conversions, ggerganov/whisper.cpp@5359861c) | MIT, "Copyright (c) 2022 OpenAI" | downloaded by the user | the notice with repository and commit; shown on each model row |
| Already bundled and so far without their texts: React, react-dom, @mediapipe/tasks-vision (Apache-2.0), the three AI provider SDKs in package.json, uiohook-napi, node-gyp-build, Electron and Chromium (already in the package), FFmpeg (GPL, its files stay next to ffmpeg.exe) | as declared | yes | their texts in THIRD_PARTY_NOTICES.txt |
| Test fixtures: JFK excerpt (public domain), LibriSpeech 1272-128104-0000 (CC BY 4.0) | | tests only | attribution in tests/fixtures/speech/README.md (committed) |
| Test data: the spike's recorded run on LibriSpeech 7729-102255 (recognised text, CC BY 4.0) | | tests only | attribution in native/speech/tests/data/README.md (committed) |

`scripts/notices.mjs` (`npm run notices`, workstream A) generates `resources/THIRD_PARTY_NOTICES.txt`
from the shipped and bundled npm packages' LICENSE files, `cargo metadata` of both crates and the
hand-written entries in `resources/notices/*.txt`; the output is committed, `--check` compares it
in predist, and verify-dist checks the package.

---

## 9. Risks

1. **What "sound" means changes** on the microphone stem: typing, clicks and other non-speech
   sound no longer count, so Remove silences may cut silent typing and music no longer ducks under
   it. Intended by F-03. Mitigations: idle still needs no input; the system stem stays level-based;
   recordings without stems use the union; the trust guard; the reviewed plan; the status line.
   The guard does not help a coding tutorial with 2 s or more of narration: Remove silences will
   list its silent typing as silences (default action cut). Keeping typing bursts from
   `cursor.json` as `keep` ranges in `findSilences` is the follow-up (§11). Existing projects'
   music ducking changes at their next export: `docs/FEATURES.md` and the release notes say so.
2. **Existing end-to-end fixtures use tones as speech.** camera-director.e2e.cjs puts a 180 Hz
   warble on a microphone stem: the director uses speech without the guard, so it moves to the real
   speech fixtures with re-derived expectations (±0.3 s). Mixed-track tone fixtures (polish,
   w3fix-timeline, ai, captions) keep passing through the union. audio-pack's microphone tones
   keep theirs only if the trust guard applies to each (10 s of sound); any case that does not is
   moved to real speech, never skipped. Every test that runs the detector asserts the helper
   exists, so nothing passes silently on the fallback.
3. **Windows speed and memory are not measured** (wine RTF 0.105 against 0.079; RSS cannot be read
   under wine; Intel hybrid cores may put below-normal threads on E-cores; Windows on ARM emulates
   x64). Mitigations: the conservative 1.3 factor, `peak_rss_mb` reported per run, measured speed
   learned per model, the manual checklist (§10.5).
4. **The compatible build is not measured** (about 4.3 times slower expected; size estimated).
5. **Non-ASCII paths**: handled by the loader callbacks; tested on Linux, under wine and manually.
6. **Unsigned builds**: Smart App Control or antivirus may block the helper; captions report
   `blocked`, the detector falls back. Releases are signed by the existing pass.
7. **Download source**: Hugging Face may rate-limit, move CDN hosts (`*.hf.co` is allowed) or the
   repository may change (last modified 2024-10-29). The commit and SHA-256 pins make a mirror safe
   to add later without trusting it. Corporate proxies work through Electron net.
8. **The parser surface** of whisper.cpp: pinned files only, mitigations (§5.4).
9. **Cancel latency** inside language detection and one encoder pass (3.6 s for small; 10-14 s
   busy): bounded by the 2 s grace and a kill.
10. **Text quality**: hallucinations in silence or music are reduced by the speech chunking;
    temperature-fallback re-decodes vary the run time (small without the detector: 52.3 s against
    25.8 s); fillers are left out (F-05 needs `--prompt` later); scripts without spaces get
    caption-level karaoke; auto-detection verified on English only.
11. **DTW memory** (`dtw_mem_size` 128 MB per call) may spike with turbo; not lowered without
    measuring.
12. **Preview/export agreement**: guaranteed by resolving the levels only after the detector
    settled; tested (§10.3).
13. **Merge with the editing-wins team**: one line in `src/shared/types.ts`, two in
    `src/shared/api.ts`, two in `src/preload/index.ts`, about 10 in `Inspector.tsx`; CaptionsPanel's
    GenerateSection and `captionItems.ts` (E-01 calls `transcribe`) are hot spots, kept additive;
    `AudioLevels.speech` is additive for E-04's waveform. Nothing in `Editor.tsx`, the timeline,
    `commands.ts` or `shortcuts.ts`.
14. **Sleep during a job**: timers reset on resume.
15. **Disk**: 115 MB per hour of temporary PCM plus up to 574 MB per model; checked before
    downloads; temporary folders swept.
16. **Determinism**: thread count and build can move speech frames and word edges slightly; tests
    use tolerances; the persisted detector result keeps preview and export identical across
    sessions.
17. **Licences**: the notices file closes today's gap for bundled packages too; verify-dist
    enforces it.
18. **Unfinished transcript parts** sit in the project's `.cache` until success; they go with the
    project folder (which may sync to OneDrive with Videos\Flown).
19. **Build toolchain grows** (cmake, libclang, posix MinGW): without it the feature is absent
    (keys only, level detector); releases require it.
20. **Turbo** is slower than real time on CPUs: labelled, gated to 8 GB PCs with the standard
    build, offered in the Captions tab only once downloaded from Settings, estimated before
    starting.
21. **Roaming profile.** userData is `%APPDATA%\Flown` (Roaming), as the requirement asks; up to
    574 MB per model there can slow domain log-ons and exceed profile quotas on managed PCs.
    Moving the models to `%LOCALAPPDATA%\Flown\speech-models` is a one-line path change for B if
    that matters more than the requirement's wording (§11).
22. **The first open waits for the detector** (§3.5 Cost): about 9 s per hour of microphone sound,
    about 40 s on the compatible build, before levels (ducking, the Clip tab, E-04's waveform)
    show; later opens read the cache.

---

## 10. Test plan

### 10.1 Unit (vitest; fixtures as literals)

**Committed now: `tests/speechContracts.test.ts`**: catalog pins (ids, tiers, files, bytes, SHA-256,
URLs at the pinned commit), ids only (paths and URLs rejected), `speechThreads`,
`memoryNeedMB`, `speechModelBlock` (an "8 GB" PC reporting 7.4 GiB passes, 6 GB and the compatible
build do not) and `modelBlockReason`, the shipped detector model against `VAD_MODEL`, the fixtures
against their README, frozen constants (`SIDECAR` with `heartbeat` and `detectMinSpeech`, `VAD`,
`VOICE`, `VAD_TRUST`, `THREAD_SPEED`, `WINDOWS_FACTOR`, `COMPAT_FACTOR`), `threadFactor` and
`estimateSeconds` (the §3.3 table, the compatible build, a measured speed), the error sentences
(tier first; every code round-trips through an Electron invoke rejection with `localErrorCode`;
other messages give null), the channels in the preload, the reserved id against keyStore's
pattern, `'local'` surviving `readTranscript`, and the `pickTranscriber` / `localModel` /
`canTranscribeNow` matrix.

**Workstream B:**

- `tests/speechProtocol.test.ts`: `readSidecarLine` for every type; rejects NaN/Infinity, wrong
  types, over-long lines, words with reversed times (dropped), unknown types (null);
  `localTranscript`: text rebuilt from words, punctuation kept, times clamped to the part and made
  monotonic, empty words dropped, at most 400 words, language passed through `languageCode`, ''
  and `auto` left out; a `result` without `language_s` is invalid.
- `tests/speechVad.test.ts`: `speechFromProbs` with 32 ms frames: 10 frames at 0.1, 20 at 0.9, 3 at
  0.2, 20 at 0.9 → one range (the 96 ms gap is under 100 ms); a 7-frame (224 ms) burst dropped;
  30 ms padding clamped at 0; hysteresis keeps speech while p ≥ 0.35; all speech, none, empty;
  `decodeProbs` rejects invalid base64 and more than `maxFrames`.
- `tests/speechDownload.test.ts` (fake `HttpGet`, temporary folder, fake timers): resume with
  206 from a 10 MB .part; 200 restarts; a wrong total restarts once then fails; a redirect off the
  allow-list or plain http (packaged) fails; a hash mismatch deletes the .part; cancel keeps it; a
  60 s stall retries and resumes, reporting `retrying: { attempt: 1, of: 3 }` meanwhile; 403 fails
  as `refused` and 404 as `missing`, neither retried; EBUSY on rename is retried; too little space
  is refused before any request.
- `tests/speechModels.test.ts`: status from disk; size/time change → re-hash → `damaged` on mismatch;
  a symlinked model is rejected; remove refused while held; .part older than 30 days swept;
  `sanitizeSpeechSettings`; a finished download becomes the default when the default is missing;
  removing the default makes the first remaining installed model the default; `setDefault` of a
  model that is not installed rejects; `allowed`/`reason` from `speechModelBlock` and
  `modelBlockReason` (turbo on the compatible build).
- `tests/speechHelper.test.ts`: the line splitter at chunk boundaries and both caps;
  `classifyExit` with Windows codes (3221225501 → illegal instruction; 3221225477 and 3221226505 →
  crash; 2 → cancelled; 1 + error line → its code) and Linux signals; a run the app aborted or
  killed is `cancelled` whatever its exit (never a crash); `chooseBuild` (AVX2 without BMI2 →
  compatible); an illegal instruction in `vad` switches the build and keeps the detector; the kill
  sequence on a fake child (`cancel\n`, end of stdin, kill after 2 s); the stall watchdog at
  120 s, reset by every line and on `resume`; the part limit max(10 min, 4 × estimate) with the
  compatible factor; a stall retried once with the same threads; the minimal environment;
  `shell: false`; `cwd` is `os.tmpdir()` for `cpu` and `vad`.
- `tests/localClient.test.ts`: cache key changes with the part, the model, the language and the
  engine version; a detected language is carried to later and cached parts only from a part with
  `language_s` ≥ 10, else later parts run with `auto`; a resumed job makes the same choice from
  the cached `languageSeconds`; `partLimits` per model; progress fraction maths; the model hold
  released on every exit path; every failure is a `localErrorMessage` whose `localErrorCode` is
  the expected code (crash twice → `crashed` with part numbers, error `memory` → `memory`, error
  `model` → `damaged`, stall twice → `stalled`, protocol → `protocol`).
- `tests/aiProviders.test.ts` (extended): `validateTranscribeOptions` accepts `{ providerId:
  'local', model: 'whisper-base' }`, rejects an unknown model, ignores `model` for providers; WAV part
  arguments (`-c:a pcm_s16le -f wav`) while the MP3 arguments are unchanged.
- `tests/speechIpc.test.ts`: every `speech:*` handler and `export:analyzeAudio`,
  `projects:detectStill`, `projects:stopAnalysis` reject a sender that is not the app page; ids are
  validated.
- `tests/audioAnalysisSpeech.test.ts`: speech added for mic, and for mix only without `mic.m4a`;
  a definitive failure caches levels without speech; a stop rejects and is not cached; the
  persisted `.cache/speech.json` is reused, and rejected when too large, stale, or with `n` or
  `audio_s` out of bounds (a stem 1 s longer than `project.duration` is accepted); concurrent mic
  and mix analyses both land in the file; a write after `stopAnalyses` is skipped and creates no
  `.cache`.

**Workstream C:**

- `tests/speechEstimate.test.ts`: the §3.3 table through `durationWords` (about 1½, 3, 10, 38 min;
  `estimateSeconds` itself is covered by the contract tests); `nextTimeLeft` (null before 10 %
  and 15 s, smoothing, no rise under 30 s); `durationWords` and `sizeWords` rounding.
- `tests/voice.test.ts`: `withTails` caps (0.3 / 0.1) and never crosses a gap; clatter not
  touching speech is dropped; `trustSpeech` false for 1.5 s of speech in 12 s of sound;
  `soundDetector` labels (`mixed` also under the guard; null with the microphone muted or at 0
  and for PC sound alone).
- `tests/soundtrackSpeech.test.ts`: without speech, `sourceActivity` deep-equals today's output on
  three literal envelopes (the regression lock); mic speech + system level = union; mix without
  stems = speech ∪ level, a superset of today's; muted gives []; missing levels give null; the
  guard case uses the level; the system stem now gets its own adaptive threshold
  (`activityThreshold`, clamped to −50..−32 dB) instead of sharing the combined envelope's: brief
  PC sounds (0.3 s notification sounds at −40 dB) on an otherwise silent system stem still count,
  and a system stem with a steady background (−38 dB music bed) with louder events keeps them.
- `tests/directorSpeech.test.ts` (extended): with `levels.speech`, typing noise does not remove
  speech; join 1.0 s and 0.6 s minimum; without speech the output equals today's literals.
- `tests/captionsPanel.test.ts` (extended): `checking` while either read is pending (no key block
  flashes); the local option first; chips labelled with size or "Downloaded", a click changing
  the session choice and never calling `setDefaultSpeechModel`; `needs-model` with another model
  installed offering "Make them now with …"; no key block for a user without keys (one cloud
  link instead); the consent card's copy with the tier, the size and the estimate; the
  compatible-build and slower-than-the-recording lines; `no-sound` offers no download; the
  command waiting for both reads, then focusing the download button and starting nothing; the
  error buttons chosen by `localErrorCode`; the cloud error link; the summary for local, with
  "Not {language}?" only after a detection; download-then-captions not starting when the editor
  closed or for another project.
- `tests/captionsBadge.test.ts`: the Captions tab's badge through `useCaptionsHost`: `download`
  with its share while this project's download runs (also while it waits to try again),
  `verify` while it is checked or installed with the intent pending, none for another project, a
  download without the intent or after it failed.
- `tests/speechCopy.test.ts`: every reason and state has copy; sizes and times inserted; every
  Captions-tab string that names a model also names its tier.

### 10.2 Native (workstream A)

- **`cargo test` in `native/speech`** (Linux): argument parsing (`args_os`, unknown flags, model
  names outside `[A-Za-z0-9._-]` rejected); the WAV reader (s16, f32; 44.1 kHz or stereo → `audio`);
  chunk packing (≤ 29 s, padding never past mid-gap, long speech cut at its quietest frame); word
  forming from synthetic token tables (a code point split across tokens, the end at the last
  letter token, the start pull-in, the onset snap, monotonic output across a chunk join); **per-chunk refinement against the recorded run**
  `native/speech/tests/data/spike-base-q5_1-clip.jsonl` (the spike's unrefined segment lines,
  fed chunk by chunk): at least 95 % of the words equal the file's whole-run `result.words`
  (±1 ms) and none is more than 150 ms apart (measured: 222 of 226 equal, at most 120 ms); the
  choice of the language-detection chunk (the first with ≥ 10 s of speech, else the most
  speech; a 1.5 s opening chunk is never chosen); the heartbeat timer (a line after 15 s of
  silence, none while lines flow); JSON escaping of control characters and lossy UTF-8; windowed
  probabilities equal whole-buffer ones within 0.02 outside the overlaps (committed model,
  synthetic signal); the loader opening a model copy at a non-ASCII path ("modèle-тест/…").
- **`npm run test:native`** (`vitest.native.config.ts`, `tests/native/*.spec.ts`; outside the main
  `tests/**/*.test.ts` pattern; fails, never skips, when `native/bin/ssw-speech` or the test model
  is missing), with the host build and ffmpeg-static decoding the FLAC fixtures:
  `cpu` reports booleans; `vad` on JFK finds speech within [0.3, 10.8] s ± 0.2 s and none in 3 s of
  generated brown noise with key clicks; `transcribe` with the test model contains "americans" and
  "country", monotonic words built from the `segment` lines alone, each word inside a speech
  range ± 0.3 s, `peak_rss_mb` reported, `language` "en" with `language_s` ≥ 10 under `auto`;
  1 s of JFK, 40 s of silence, then JFK again: still "en", detected on the second chunk
  (`language_s` ≥ 10); a run with `--lang en` reports `language_s` 0; silence only: `language`
  '';
  `cancel` through stdin gives a cancelled line within 5 s; a truncated model copy gives error
  `model` without a crash; an 8 kHz WAV gives `audio`; a non-ASCII model folder works; the test
  model's pin equals the catalog's `whisper-tiny`.
- **Wine smoke** (`scripts/smoke-speech-wine.sh`, optional in CI): both exes import only the
  allowed system DLLs (objdump, the verify-dist list); `cpu` (with `sse42` and `bmi2`); `vad` and
  `transcribe` (tiny) on JFK from a non-ASCII folder; cancel exits 2 within 1 s; the compatible
  exe gives the same words; its RTF on the clip is reported.
- **Bench** (`native/speech/bench`, manual, needs the base model and `fetch_speech.py`'s clip and
  truth): `eval_stream.py` on base q5_1, 4 threads, detector on, from the helper's own lines:
  start median ≤ 50 ms and ≥ 90 % within 200 ms (the spike's lines refined per chunk gave
  45 ms and 92.4 %), recorded in §2.1; base on 60 minutes stays at or under RTF 0.12 and 450 MB
  peak per part.

### 10.3 End to end in this container, offline after one fetch

How it runs:

1. `npm run build:speech-host` (cargo, crates.io once, then cached; 59 s from clean).
2. `npm run fetch:test-speech`: downloads the catalog's `whisper-tiny` (ggml-tiny-q8_0.bin,
   43,537,433 B, SHA-256 c2085835…) from its pinned address into `.cache/test-speech/` (gitignored;
   `SSW_TEST_SPEECH_CACHE` overrides), resumable, checked, reused (1-2 s here). The model is not
   committed: 43.5 MB would multiply the repository's size several times. The speech detector model
   and the speech fixtures are committed, so nothing else is fetched.
3. `npm run build`, then `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/offline-captions.e2e.cjs`.

The app finds the host helper at `native/bin/ssw-speech` (unpackaged path) and downloads models
from the mock server: `tests/e2e/ai-mock-server.cjs` gains an `/hf/` route serving the cached
model with Range/206 and faults (`cut=N` closes after N bytes, `flip` changes one byte, `404`,
`slow`), and the app gets `SSW_SPEECH_MODEL_BASE_URL=http://127.0.0.1:<port>/hf/`. A missing helper
or model fails the test with the commands above; it never skips.

The speech fixture (`tests/e2e/speech-fixtures.cjs`, built with ffmpeg from the committed FLACs):
`mic.m4a` = 0-1 s silence, 1.0-12.0 s JFK, 12.0-16.0 s brown noise at -45 dBFS with 5 ms key
clicks at 8 Hz, 16.0-21.86 s LibriSpeech, silence to 23.86 s; the project is seeded with
`audioStems { mic: true, system: true }` (a silent `system.m4a`) and a mixed track of the same sound.

**`tests/e2e/offline-captions.e2e.cjs`** (workstream C):

1. **Consent.** No providers, no model: "Checking this PC…" first, then the card with the only
   primary button "Download 60 MB and make captions" (Standard), no "Add an AI provider" block and
   the one link "Prefer the cloud? …"; the chips read "Fast · 44 MB", "Standard · 60 MB",
   "Accurate · 190 MB" and no "Most accurate"; choosing Fast changes the button to "Download 44 MB
   and make captions" and the estimate, and `speech.json` (if any) still names base as default;
   the palette's "Generate captions" focuses that button and the mock logs no `/hf/` request.
2. **Download, resume, verify.** Fast with `cut=20000000`: the download stops, shows "trying
   again (1 of 3)", retries by itself with `Range: bytes=20000000-` (mock log), completes, shows
   "Checking the download…" with focus on the card's heading; the file in
   `<userData>/speech-models` has the pinned SHA-256 and `speech.json` names `whisper-tiny` as the
   default (a download from the Captions tab). Meanwhile, with the Clip tab open, the badge has
   `data-phase="download"`.
3. **Mismatch**: `flip` → the mismatch copy, no `.part` or file left; started from the Captions
   tab and then switching to the Clip tab, the editor notice "The speech model could not be
   downloaded: open the Captions tab for details." appears. **404**: the `missing` copy with
   [Choose another tier]. **403**: the `refused` copy. **Slow + Cancel**: Settings shows "Stopped
   at …"; Continue completes it. **Closed during a download**: start Fast's download from the
   Captions tab, close the editor; the download completes; reopening shows `ready` and no job
   starts by itself.
4. **Generate.** The words (lowercased, punctuation stripped) include "americans", "country" and at
   least two of "apostle", "middle", "classes", "gospel"; every segment has words with
   words.length equal to its text's word count; times monotonic, not overlapping; every word inside
   [0.7, 12.3] ∪ [15.7, 22.2] s and none in the noise; `project.json` has `provider: 'local'`,
   `model: 'whisper-tiny'`; captions shown; one Ctrl+Z removes them; the summary reads "… made on
   this PC with Whisper tiny (English, detected) …"; the badge and the "Captions ready" notice
   appear while the Clip tab is open.
5. **Cancel and resume, deterministic.** With `SSW_AI_MAX_PART_SECONDS=8` (3 parts) and
   `SSW_SPEECH_HELPER` set to `tests/e2e/speech-hold-helper.sh` (unpackaged-only override; a bash
   script, mode 755, `#!/bin/bash`): when its arguments contain `part-1.wav` it prints a `ready`
   line and a `progress` line, then blocks on `read -t 30 line` on stdin; the app's `cancel` line
   or the end of stdin ends the wait, and it prints `{"type":"cancelled","done_until":0}` and
   exits 2. Any other call `exec`s the real helper found relative to the script
   (`$(dirname "$0")/../../native/bin/ssw-speech`: the helper's environment is minimal, so no
   variable can carry the path). Cancel once the running block shows `data-part="2"`; no process
   whose command line contains the helper's or the wrapper's path remains within 3 s and the
   `ssw-transcribe-*` folder is gone; the "Stopped. 1 of 3 parts are kept" line shows. Then
   restart the app **without** the wrapper (the override is read once per session; the restart
   also proves the part cache survives it) and Generate: exactly "Continuing: 1 of 3 parts were
   already done", and the words equal an uninterrupted run's within the tolerances.
6. **Offline.** With the model installed and the mock server stopped, captions are still made.
7. **Settings.** Opened at `speech` from "Manage speech models…", the section's heading has focus;
   the Fast row shows Downloaded and its radio is enabled, the Accurate row's is not; Remove →
   [Remove] → file deleted, the Captions tab returns to the consent card. With tiny and base both
   downloaded and Accurate chosen in the tab: `needs-model` with "Make them now with Standard
   (downloaded)", which makes captions with base.
8. **Helper missing** (`SSW_SPEECH_HELPER=/nonexistent`): On this PC is not offered and the hint
   says why; a key provider of the mock still transcribes.
9. **Speech detector.** Remove silences on the fixture project: a silence covers 12.3-15.7 s and
   `silence-detector` has `data-detector="speech"`; with the helper missing: `level`, the clatter is
   not a silence. Music ducking: preview gain samples and the exported PCM duck under the speech
   and not under the clatter, at the same output times (±0.05 s); with the helper missing both duck
   under the clatter and still agree. Restarting the app and opening the editor again starts no
   `vad` process (`.cache/speech.json` reused; main's in-memory level cache is gone after the
   restart, so this proves the file is read).
10. **Security.** `window.api.downloadSpeechModel('../../x')`, a URL and an unknown id reject; a
    frame that is not the app page cannot call `speech:*` (in the style of audit-security).

### 10.4 Existing tests that change (none skipped)

- `camera-director.e2e.cjs`: `micAudio` becomes real speech at the same intervals (0.5-6, 17-22,
  34-46.5 s) from the committed FLACs; expectations re-derived (±0.3 s); a new case with the helper
  missing keeps today's energy path.
- `captions.e2e.cjs`: the provider list gains "On this PC (free, private)" first when the helper
  is built; the no-provider and no-transcribing-provider cases now expect the consent card with
  the link "Prefer the cloud? Use your own OpenAI or Gemini key…" instead of the key block (which
  appears only when reading the providers failed); with `SSW_SPEECH_HELPER=/nonexistent` the key
  block and its text are exactly today's.
- `ai.e2e.cjs`: the AI providers intro gains its sentence.
- `audio-pack.e2e.cjs`: each microphone-tone case either asserts the guard line
  (`data-detector="guard"`) with today's numbers or moves to real speech with re-derived numbers.
- `polish.e2e.cjs`, `w3fix-timeline.e2e.cjs`: mixed track through the union. Silero should give
  about nothing on sine tones, but a speech range on a tone, padded and with its tail, could
  extend a sound range a little: the numbers keep their tolerances or the assertion becomes "a
  superset of today's sound" where an exact equality was asserted; plus an assertion that the
  helper exists.
- `tests/packaging.test.ts`: the new extraResources entries.

### 10.5 Manual, Windows (Windows-unverified until run)

Base on 60 minutes and turbo on 10 minutes on a 4-core and an 8-core laptop (time against the
estimate, peak memory, measured speed saved); preview smoothness while captions run; a non-ASCII
user name; Smart App Control on with Defender; a signed build; a corporate proxy download; sleep
and resume during a job and a download; a CPU without AVX2 (a VM with CPUID masking) using the
compatible build, and one with AVX2 but no BMI2; killing Flown in Task Manager (the helper
exits); cancel latency with turbo; the process mitigations active on a running helper
(`Get-ProcessMitigation -Id <pid>`: extension points disabled, image-load policy) as a release
gate; an "8 GB" PC's reported memory (turbo allowed); a Roaming-profile domain log-on with a
model downloaded.

---

## 11. Later (not in this wave)

- A Vulkan build (whisper-rs-sys feature `vulkan`; `vulkan-1.dll` comes with GPU drivers) to make
  turbo practical; GPU detection in the model manager.
- Parakeet TDT 0.6B v3 through sherpa-onnx as a fast English/European engine (CC-BY-4.0
  attribution).
- Speaker labels (NW-09; the mic and system stems give a two-speaker split without AI).
- Fillers and retakes (F-05, NW-01): a verbatim `--prompt`, word normalisation (punctuation).
- Streaming input to the helper and resume inside a part (`--start`), a "Continue" card when the
  editor reopens, estimates that count only speech seconds, part cuts from the speech detector.
- A refreshable catalog and a Qbexel-hosted mirror with the same pins (NW-15); English-only models.
- `MicrosoftSignedOnly`, dynamic-code prohibition and strict handle checks after a Windows check;
  an MSVC build; ggml backend DLL variants; a lower `dtw_mem_size` after measuring.
- The models in `%LOCALAPPDATA%` if Roaming profiles prove a problem (risk 21).
- A levels-only request for display uses (E-04's waveform) that does not wait for the detector.
- The speech detector on PC sound (the system stem); keeping typing bursts in Remove silences as an
  option.
- Per-character karaoke for scripts without spaces; per-word confidence in the transcript editor.

---

## 12. Work split

Three parallel workstreams with disjoint files, each on its own branch from
`feat/offline-captions-contracts`. A file not listed is out of bounds; ask the lead.

**Committed with real code (frozen; change only with the agreement of all three, recorded here):**
`src/shared/speech/catalog.ts` (with `SPEECH_TIER_NAMES`, `needsStandardBuild`,
`speechModelBlock`), `src/shared/speech/transcriber.ts`, `src/shared/speech/errors.ts` (the shared
failure sentences: `LocalCaptionsError`, `localErrorMessage`, `localErrorCode`, `tierLabel`,
`quickerModel`, `UNAVAILABLE_REASONS`, `modelBlockReason`), in `src/shared/speech/estimate.ts`
`COMPAT_FACTOR`, `threadFactor` and `estimateSeconds` (main's part limit uses them),
`src/shared/api/speech.ts`, `src/shared/api/ai.ts`, `src/shared/api/brand.ts`,
`src/shared/api.ts`, `src/shared/types.ts`, `src/shared/audio/loudness.ts` (the `speech` field),
`src/shared/captions/captionData.ts`, `src/preload/speech.ts`, `src/preload/index.ts`,
`src/preload/brand.ts`, `src/main/index.ts`, `src/main/ai/types.ts` (`input`, `onProgress`,
`PartProgress`; B may add fields), `src/main/brandIpc.ts` (`brand:notices`; B may refine),
`resources/speech/ggml-silero-v6.2.0.bin`, `tests/fixtures/speech/*.flac`,
`tests/speechContracts.test.ts`, `docs/design/offline-captions.md`.

**Committed as stubs** (every exported name, type, constant and signature frozen; bodies and
private helpers free):

| File | Exports | Bodies |
|---|---|---|
| `src/shared/speech/protocol.ts` | `SIDECAR` (with `heartbeat`, `detectMinSpeech`), every `Sidecar*` type (`SidecarCpu.sse42`/`bmi2`, `SidecarResult.language_s`), `readSidecarLine`, `localTranscript` | B |
| `src/shared/audio/vad.ts` | `VAD`, `VadOptions`, `decodeProbs`, `speechFromProbs` | B |
| `src/shared/audio/voice.ts` | `VOICE`, `VAD_TRUST`, `SoundDetector`, `withTails`, `speechActivity`, `trustSpeech`, `soundDetector` | C |
| `src/shared/speech/estimate.ts` | `THREAD_SPEED`, `WINDOWS_FACTOR`, `TIME_LEFT`, `nextTimeLeft`, `durationWords`, `sizeWords` (the rest is real code, above) | C |
| `src/main/speech/speechIpc.ts` | `registerSpeechIpc` (registers nothing yet) | B (the name is frozen) |
| `src/main/speech/{helper,download,models,localClient,vad}.ts` | skeletons (`SPEECH_TIMING` holds the §3.4 numbers) | B's own (may change) |
| `native/speech/` | the spike's crate (`ssw-speech`), README, bench scripts (`eval_stream.py`), `tests/data/` (the spike's recorded run) | A's own |

Stub bodies throw (pure modules) or do nothing (main modules), and nothing calls them yet: the app
behaves exactly as before the contracts commit. The one visible change is `CaptionsPanel.tsx`'s
`TRANSCRIBER_NAMES` (needed by the wider `Transcript.provider`), which shows nothing new until a
local transcript exists.

### Workstream A: native engine, build, packaging, notices, test assets

- **Owns:** `native/speech/**`; `scripts/build-native.mjs`; `scripts/lib/packaging.cjs`;
  `scripts/lib/pe.cjs`; `electron-builder.config.cjs`; `scripts/predist.mjs`;
  `scripts/verify-dist.mjs`; `scripts/notices.mjs` (new); `resources/notices/*.txt` (new);
  `resources/THIRD_PARTY_NOTICES.txt` (new, generated, committed); `resources/speech/MODEL.md`;
  `scripts/fetch-test-speech.mjs` (new); `scripts/smoke-speech-wine.sh` (new);
  `vitest.native.config.ts` (new); `tests/native/*.spec.ts` (new); `tests/fixtures/speech/README.md`;
  `tests/packaging.test.ts`; `tests/e2e/packaging.e2e.cjs`; `package.json` (scripts
  `build:speech-host`, `notices`, `fetch:test-speech`, `test:native`; no new dependency);
  `.gitignore`; `docs/BUILDING.md`; `native/README.md` (a pointer only).
- **Builds:** the crate to §2.4-2.5 and §5.2, line for line with the frozen `protocol.ts`
  (modules `protocol.rs`, `wav.rs`, `loader.rs`, `vad.rs` windows with probabilities, `chunks.rs`,
  `words.rs`, `lang.rs`, `guard.rs`; subcommands `cpu | vad | transcribe`; the spike's `info`
  subcommand and extra fields go, or appear only with `--verbose`):
  - **final word times in every `segment` line:** the pull-in with the median of the raw word
    lengths so far (seeded by the first chunk), the onset snap with the part's speech ranges, and
    starts kept after the previous word's end across chunk joins, all before the chunk's lines are
    printed;
  - a **heartbeat** `progress` line from the control thread whenever 15 s passed without a line;
  - **language** detected once on the first chunk with ≥ 10 s of speech (else the most speech),
    reported with `language_s`, '' when there was no speech;
  - `cpu` with `sse42` and `bmi2`; `vad` with `--low-priority` and `--parent-pid`; peak memory
    through `K32GetProcessMemoryInfo` (Windows) or `getrusage`; the CPUID check at the start of
    `main`; the parent watch; mitigations for extension points and image loads only (§5.3);
  - the three builds and their environment (§6.1); the packaging entries (§6.2); verify-dist
    (§6.3: the import allow-list with bcryptprimitives, the speech payload budget of 3.5 MB
    brotli-compressed and 10 MB installed, no whole-installer baseline); predist; the notices
    generator (§8); the test-model fetch script (pin read from a copy checked against `catalog.ts`
    by a test); the native tests (§10.2) and the wine smoke script.
- **Uses, does not change:** the frozen files, especially `protocol.ts`, `catalog.ts` and
  `errors.ts` (the helper's error codes map to its sentences in main, not in the helper).
- **Verify:** `cargo test` (including the per-chunk refinement against
  `tests/data/spike-base-q5_1-clip.jsonl`, the language-chunk choice and the heartbeat) and
  `cargo clippy` in `native/speech`; `node scripts/build-native.mjs --require` (both exes, then
  `--speech-host`); `npm run fetch:test-speech`; `npm run test:native`;
  `scripts/smoke-speech-wine.sh`; `npm run notices -- --check`; both typechecks;
  `npx vitest run --testTimeout=60000`; the bench gate (`bench/eval_stream.py`, base q5_1 on the
  105.7 s clip from the helper's own lines: start median ≤ 50 ms, ≥ 90 % within 200 ms). Report
  the gate's numbers (for §2.1), the measured sizes (raw, xz and brotli) of both exes and the
  notices file, both exes' import lists, and the compatible build's RTF on the clip under wine.

### Workstream B: main process

- **Owns:** `src/main/speech/*` (the stubs and any new private modules); `src/main/ai/transcribe.ts`;
  `src/main/ai/types.ts`; `src/main/audioAnalysis.ts`; `src/main/exportIpc.ts` (the sender check
  only); `src/main/analysisIpc.ts` (sender checks); `src/main/brandIpc.ts`; the bodies of
  `src/shared/speech/protocol.ts` and `src/shared/audio/vad.ts`; tests `speechProtocol`, `speechVad`,
  `speechDownload`, `speechModels`, `speechHelper`, `localClient`, `speechIpc`,
  `audioAnalysisSpeech` (all new), `aiProviders.test.ts`, `analysisIpc.test.ts`, `exportIpc.test.ts`
  (extended); `docs/IMPLEMENTATION.md` (layout: `src/main/speech/`).
- **Builds:** §3.1-3.5 and §3.7 on the main side:
  - the model store and downloads: `retrying` status, 403 as `refused`, the default-model rules
    of §3.1 (first download, removing the default, `setDefault` only for installed models),
    `allowed`/`reason` from `speechModelBlock` and `modelBlockReason`;
  - the helper runner and build selection: `chooseBuild` with BMI2, an illegal instruction in
    `transcribe` or `vad` switching the build, `os.tmpdir()` for `cpu` and `vad`, `vad` at low
    priority with the parent watch, the 120 s stall rule and the per-part limit with
    `estimateSeconds` (build-aware), a stall retried once with the same threads, an aborted run
    counted as `cancelled` before `classifyExit`;
  - the local client: the part cache with `languageSeconds`, the language carried only from a
    part with `language_s` ≥ 10, '' and `auto` never stored, every failure thrown as
    `new Error(localErrorMessage(...))` from `errors.ts`;
  - the `transcribeProject` branch, WAV parts, progress fields and speed learning;
  - the speech detector service with persistence (writes serialised per project and skipped
    after a stop; `audio_s` bounds) and the levels' `speech`;
  - every `speech:*` handler with sender checks and the throttled `speech:changed`, and the
    hardening of the three existing handlers.
- **Verify:** both typechecks; `npx vitest run --testTimeout=60000`. With A's host build present
  (or a fake helper script through `SSW_SPEECH_HELPER`, like the nativeCapture tests), `npm run dev`
  and from the devtools: `await window.api.getSpeechState()`, `await
  window.api.downloadSpeechModel('whisper-tiny')`, then `await window.api.transcribe(<id>, {
  providerId: 'local' })` on a recording; a rejected job's message gives the expected
  `localErrorCode`.

### Workstream C: renderer, shared consumers, UI, end to end

- **Owns:** the bodies of `src/shared/audio/voice.ts` and of `nextTimeLeft`, `durationWords` and
  `sizeWords` in `src/shared/speech/estimate.ts`; `src/shared/speech/speechCopy.ts` (new; renderer
  copy only); `src/shared/audio/soundtrack.ts` (`sourceActivity`); `src/shared/audio/speech.ts`
  (`speechFromLevels`, `DirectorSpeech.detector`); `src/shared/editor/directorCopy.ts`;
  `src/renderer/src/editor/directorAnalysis.ts` (passes `levels.speech` and the detector to
  `refineSpeech`, a few lines); `src/renderer/src/editor/panels/CaptionsPanel.tsx`,
  `src/renderer/src/editor/captions.css`, `src/renderer/src/editor/panels/LocalCaptions.tsx` (new),
  `src/renderer/src/editor/speechState.ts` (new: `useSpeechState` with loading kept apart from
  failure, the session's chip choice, download-then-captions keyed by project);
  `src/renderer/src/editor/captionItems.ts` (additive only: `startedAt` on the job);
  `src/renderer/src/editor/Inspector.tsx` (the badge, about 10 lines);
  `src/renderer/src/editor/panels/ClipPanel.tsx` and `AudioPanel.tsx` (lines and hints);
  `src/renderer/src/styles.css` (additive only: a shared `.sr-only`);
  `src/renderer/src/settings/SpeechModelsSection.tsx`, `speech.css`, `NoticesPanel.tsx` (new),
  `SettingsDialog.tsx`, `SettingsButton.tsx`, `AboutSection.tsx`, `AiProvidersSection.tsx`; tests
  `speechEstimate`, `voice`, `soundtrackSpeech`, `speechCopy` (new), `directorSpeech.test.ts`,
  `captionsPanel.test.ts` (extended); `tests/e2e/offline-captions.e2e.cjs`,
  `tests/e2e/speech-fixtures.cjs` and `tests/e2e/speech-hold-helper.sh` (new),
  `tests/e2e/ai-mock-server.cjs` (the `/hf/` route), `tests/e2e/helpers.cjs` and
  `tests/e2e/render-fixtures.cjs` (additive), `tests/e2e/camera-director.e2e.cjs`,
  `captions.e2e.cjs`, `ai.e2e.cjs`, `audio-pack.e2e.cjs`, `polish.e2e.cjs`,
  `w3fix-timeline.e2e.cjs`; `docs/FEATURES.md`, `docs/ROADMAP.md` (F-01, F-03, F-13 minimal,
  LT-20; the ducking change of existing projects in the release notes).
- **Builds:** §3.6 and §7: the consumers with the regression lock; the Captions tab's transcriber
  choice with the `checking` state, the session-only chips with visible size or "Downloaded",
  every state of §7.2 and its copy (tier first; the one primary action and one cloud link for
  users without keys; "Make them now with …"; the slow-PC and language lines; error buttons from
  `localErrorCode`); download-then-captions, the badge and the notices (§7.6); Settings › Captions
  on this PC (§7.3); the inline notices (§7.5); the Clip, Audio and director lines and hints; the
  accessibility rules (§7.7); the end-to-end file and the migrated tests. Cut first if time is
  short: the "Exporting now slows the captions down." line.
- **Verify:** both typechecks; `npx vitest run --testTimeout=60000`. Until B lands, `speech:*`
  invokes reject ("No handler registered"): the rejected read counts as unavailable, so the
  Captions tab must then behave exactly as today (keys only) and log the rejection; the section
  and the consent card can be built against a fake `SpeechState` (as in the unit tests). The
  end-to-end file runs at integration.

### Integration

Merge this contracts commit to main as soon as it is reviewed (it is behaviour-neutral), so the
editing-wins team's E-01 can import `transcriber.ts`; tell them to rebase, and tell them about
`AudioLevels.speech`, the first-open wait (§3.5 Cost, it delays E-04's waveform) and
`CAPTIONS_SKIPPED_NO_MODEL`. Then merge A, then B, then C (disjoint); resolve nothing in frozen
files. Run both typechecks, the whole vitest suite, `cargo test` in `native/speech`, `npm run
build:speech-host`, `npm run fetch:test-speech`, `npm run test:native`, `npm run build`, then
`xvfb-run -a node tests/e2e/run-all.cjs offline-captions captions ai camera-director audio-pack
polish w3fix-timeline audit-security ui smoke`, and `npm run dist:win` with verify-dist (the
speech payload against §6.4). Tune only through the exported constants (`VAD`, `VOICE`,
`VAD_TRUST`, `THREAD_SPEED`, `WINDOWS_FACTOR`, `COMPAT_FACTOR`, `TIME_LEFT`, `SPEECH_TIMING`,
`DOWNLOAD`, `SIDECAR.heartbeat`, `SIDECAR.detectMinSpeech`), updating this document. The manual
Windows list (§10.5) stays Windows-unverified in `docs/FEATURES.md` until run.

---

## 13. Review notes

Two reviews of the first version. Every blocking finding was checked against the code and found
right; each is fixed above:

- **Word times on the wire** (§2.1, §5.2): the spike refined words only for its result line, which
  the protocol drops; its segment lines measured 55 / 320 ms / 83.9 %. Refinement now runs per
  chunk before printing (measured on the spike's lines: 45 / 145 ms / 92.4 %), with a cargo test
  on the recorded run and a bench gate.
- **Stall watchdog** (§1, §3.4): whisper.cpp reports progress once per 30 s window
  (`src/whisper.cpp` around line 7000). Heartbeat every 15 s, 120 s stall, a per-part limit of
  max(10 min, 4 × estimate), turbo not offered on the compatible build.
- **Shared error contract** (§3.4, §7): `src/shared/speech/errors.ts` with a round-trip test.
- **Language from a short first chunk** (§2.5, §3.2): detection on ≥ 10 s of speech, `language_s`,
  carry-over only from such a part, '' and `auto` never stored.
- **Flaky cancel-and-resume e2e** (§10.3 item 5): a wrapper that holds `part-1.wav`, then a
  restart without it.
- **Chips that changed the default** (§3.1, §7.1-7.3): chips are session-only; a download from the
  Captions tab becomes the default; "Make them now with …"; visible labels; Settings radios only
  on downloaded rows.
- **Two primary actions for users without keys** (§7.1, §7.2, §10.4): one primary button, one
  cloud link; the key block only when the providers could not be read.
- **Estimates 4 times too optimistic without AVX2** (§3.3, §7.1): `COMPAT_FACTOR` in
  `estimateSeconds` (now real code), the slow-PC and slower-than-the-recording lines.
- **Invisible download outside the tab** (§7.6): the badge covers the download, a failure notice,
  the intent keyed by project and dropped when its editor closes.
- **Two names for one model** (§7): tier first, model once in brackets, in every Captions-tab
  sentence; a copy test enforces it.

Minor findings applied: BMI2 and SSE4.2 in the probe and the SIGILL guard reworded (also for `vad`);
aborted runs never count as crashes; `bcryptprimitives` in the import allow-list and
`K32GetProcessMemoryInfo`; `os.tmpdir()` for `cpu` and `vad`; `vad` at low priority with the
parent watch; serialised `.cache/speech.json` writes with the generation check; the `audio_s`
bound; the per-part work figures; the restart in e2e item 9; download-then-captions after the
editor closed; dynamic-code and strict-handle mitigations deferred with a release-gate check;
a speech-payload budget instead of a whole-installer baseline; the first-open wait and the two
speech-to-range rules documented; tone fixtures keep tolerances or assert a superset; the system
stem's own threshold tested; the loading state; focus while verifying; no live region on the
visible blocks and a shared `.sr-only`; the badge `aria-hidden`; `aria-disabled` with visible
reasons; the `retrying` state; the offline check; the failure copy (0 MB, 403 as `refused`,
buttons that can help); the clearer stopped-download buttons; the line after a cancel; the
reopened summary; the language hint before Generate; Settings `reveal`, focus and "Manage speech
models…"; [Remove] [Cancel]; the small print as plain text; no download offer without sound;
the ducking change in the release notes; turbo as a chip only once downloaded; memory warnings
only for small and turbo; E-01 waits for both reads; ownership of `directorAnalysis.ts` and the
e2e helpers; merging the contracts to main early (Integration).

Declined or changed, one line each:

- Nested notices dialog fixed with Esc and Tab handling (review 2): replaced by an inline
  disclosure in About (§7.5), which removes the conflict instead of managing it.
- Moving `.director-live` into `styles.css`: out of these workstreams' files; a shared `.sr-only`
  is added and the de-duplication is left for later.
- Models in `%LOCALAPPDATA%` instead of Roaming userData: the requirement names userData; kept,
  recorded as risk 21 with a one-line way out (§11).
- A levels-only request for display uses (E-04): an IPC change in a file the other team uses;
  documented (§3.5 Cost), told at the merge, later (§11).
- Keeping typing bursts as `keep` in Remove silences: a product change with its own tests; later
  (§9 risk 1, §11).
- Marking silence rows that contain typing: the Clip tab's status line already says typing does
  not count; a per-row mark is later with the typing-bursts option.
- Cutting speed learning per PC (review 2, over-scope): kept; it is a few lines in B and makes the
  estimates and the per-part time limit right after the first long run.
- "Streamed words equal a whole-run refinement within 50 ms" (review 1): measured 4 of 226 starts
  up to 120 ms apart (the first chunk's median differs) while accuracy is equal or better, so the
  cargo test asks for ≥ 95 % identical and none over 150 ms, and accuracy is gated by the bench.

Code review of the merged feature (main process), one line each:

- **A complete .part downloaded again** (MAIN-2, §3.1 step 3): a verified .part whose rename an
  antivirus held past the retries was resumed with a Range from its end, and the 416 deleted it;
  now each attempt hashes a complete .part and installs it without a request. The rename retry
  window is unchanged.
- **A blocked helper reported as a crash** (MAIN-3, §3.4): Node closes a child that never started
  with a negative errno as its code, so runHelper's spawn-error branch never matched and
  transcription treated a quarantined `ssw-speech.exe` as a crash (re-hash, retry, "stopped
  unexpectedly"); the spawn error now wins and the part runner maps it to `unavailable`.
- **A damaged detector model blamed on the Whisper model** (MAIN-4, §3.2 item 1): the helper calls
  both models' load failures `model`, so a missing `ggml-silero-v6.2.0.bin` showed "damaged …
  Download it again", whose download found the Whisper file intact; `localSpeechClient` now runs
  the detector's once-per-session check first (`detectorModelOk`) and refuses with
  `unavailable` (`missing`).
- **A learned speed that shortened the kill limit** (MAIN-1, §3.2 item 8, §3.4): a speed learned
  on a mostly silent part (the helper transcribes only speech: 4.7 to 7.7 times faster measured)
  or carried by the roaming profile from another PC or build cut a dense part's limit below its
  real time, so slow PCs failed "stalled" on every Generate. `partLimitMs` now takes the larger of
  the measured and the catalog estimate for this build; speed is learned only from parts at least
  half speech, and kept per build.
- **Recordings over about 7 hours ran the detector in vain** (consumers-02, §3.5): its one result
  line cannot hold them, which the helper finds only after reading all the sound, and every
  session repeated that wait before the levels settled; `speechOfFile` now skips the run when
  `project.duration` does not fit (`vadLineFits`), and `detect` stops it once the levels show
  such a length.
- **A job orphaned by a crashed page** (MAIN-5, §3.4): only the editor's dispose stopped a
  transcription, so after the main window's renderer died the job ran on unseen, Generate on the
  reopened recording was refused and Remove of its model too, and its finished result went to the
  dead frame while the part cache was deleted. `attachRecorderWindow`'s `render-process-gone` now
  stops every transcription (`stopEveryTranscription`, the cancel path, which keeps the parts).
  Then a reload (Ctrl+R keeps the renderer, so no `render-process-gone`) still left the job running:
  `ai:transcribe` now also ties the job to the page that asked (`did-navigate`, `destroyed`,
  `render-process-gone` stop it the same way, like an export's owner).

Code review of the merged feature, native engine and build (fixed unless noted):

- **NATIVE-01** Long speech cut mid-word (§2.5): whisper.cpp's `max_speech_duration_s` never kept
  its split, so ranges over 28.5 s were cut at fixed points. `chunks::plan` now cuts at the
  quietest frame of the detector's own probabilities and whisper.cpp's option is off; cargo test
  `long_speech_is_cut_where_the_detector_heard_the_least`.
- **NATIVE-02 / INT-T2** `dist:win` failed without cargo (§6.3): `notices.mjs` keeps the committed
  Rust crates' section with a warning when cargo is missing, unless `SSW_REQUIRE_NATIVE=1`; the
  rest is still generated and checked (tests/packaging.test.ts).
- **NATIVE-03** A broken detector model read as a damaged Whisper model (§5.2): `transcribe`
  reports it as error `args` naming `--vad-model` (no protocol change); the main-side pin check
  is MAIN-4.
- **NATIVE-04** The Rust standard library was not credited (§8): `resources/notices/22-rust-std.txt`.
- **NATIVE-05** A required build on Windows always failed (§6.1): usable prebuilt speech helpers
  in `native/bin` are reused.

Code review of the built feature, the captions UI (`fix/oc-ui`), one line each:

- **INT-T3** Polish's Captions row said "Finishing…" while the speech model loaded:
  `transcribePhaseText` maps `loading` to `phaseLine('loading')` ("Loading the speech model…").
- **UI-4** The ring was hidden on the compact rail, whose rule hides every span in a tab button:
  the ring's rule sets `display: block` and wins on specificity (a stylesheet test checks both).
- **UI-5** Arrow keys on the Quality chips also stepped the playhead (the editor's window keydown
  handler): the chips' handler stops the event's propagation after choosing a chip.
- **UI-1** After a disk-full failure Check again could never get out (main keeps the failure until
  a new download): `downloadFailed` offers [Try again] once the re-read free space covers the
  download (`downloadSpaceNeeded`, the main process's 64 MiB spare) or cannot be read.
- **UI-7** "Make them now with {tier} (downloaded)" started without selecting that chip, so
  Regenerate reopened on the tier that is not downloaded: `startLocal` selects the model it runs,
  after the replace question (a "no" leaves the chip alone).
- **UI-8** Download-then-captions replaced existing captions without the replace question every
  other Regenerate asks: `LocalAction` gets `confirmReplace` and its download buttons ask at the
  click.
- **UI-9** "N of M parts are kept" showed for any tier and language, though the part cache is keyed
  by both: the kept record stores the run's model and language and `localState` matches them.
  Not the Sound chip: the job does not carry its source (`captionItems.ts`), and a changed source
  only makes the line promise parts that are then made again, as before.
- **UI-10** A chosen Most accurate that was removed or damaged left no chip checked (Tab skipped
  the group) and offered its 574 MB download: `chosenModel` falls back to a model the chips offer,
  by one predicate (`offered`) that `chipModels` uses too. The session choice itself is kept, so
  the chip comes back if that model is downloaded again.
- **UI-3** While one model downloaded, another tier's card offered its download, which replaced
  the first one's intent before the main process refused it: the download buttons are blocked with
  a visible reason (`otherDownload`, `downloadBusyLine`), and `downloadThenCaptions` leaves the
  running download's intent alone. The refusal itself is not shown in the card: with the buttons
  blocked it only follows a click on a state not yet updated, and it is logged.
- **UI-2** A resumed job showed "about 1 s left" throughout: the baseline of the time left was the
  first cached part, so the later cached parts counted as work done in no time. `LocalRunning`
  starts it again whenever `resumed` changes, so only this run's work sets the speed.
- **UI-6** Settings rows let the focus fall to the body when Download became Cancel, Cancel became
  Continue, or a confirmed Remove closed its question: each row catches it on a change of what it
  shows (not on mount) and gives it to its action, else its status line.

Review of the merged build, fixed (one line each):

- **Clip tab status line** (consumers-01): `soundDetector` said `level` ("the speech detector is
  not available, so typing counts") when no voice source was heard (the mic muted or at 0, or PC
  sound alone) and `guard` ("…on the microphone") for a recording without stems. It now returns
  null without a heard voice source (no line) and `mixed` for the mixed track under the guard
  (§3.6, §7.4); `tests/voice.test.ts`.
- **The badge e2e** (INT-T4): §10.3 item 2 passed through "or the retry request was made" even
  without a badge. The retry now stays slow until the badge shows `data-phase="download"` with no
  alternative, "trying again" is caught by an observer in the page instead of a 100 ms poll, and
  `tests/captionsBadge.test.ts` covers the download and verify phases of `useCaptionsHost`.
- **Docs** (INT-T6): FEATURES, README, RELEASE-NOTES, ROADMAP and IMPLEMENTATION described Polish
  captions as needing a provider, captions as key-only, F-01/F-03 with planned builds and sizes
  (Vulkan, 142/466 MB, 2.3 MB), and the guard as applying to the director; they now match the code.

---

## 14. Bangla model

Status: built on `feat/bangla-model` after 0.4.0. The owner asked for better Bangla captions on
this PC, offline and free. The shipped models are unusable for Bangla (large-v3 turbo with
`--lang bn`: WER 98 %, CER 72 %; it mixes in Hindi and English), so a Bangla-only model joins the
catalog. Everything below is additive: other languages, existing users, settings and projects
behave exactly as before.

### 14.1 Decisions and numbers

Measured in this container with the app's own helper (`native/bin/ssw-speech`, 4 threads, AVX2)
on 59 clips (12.5 min) of FLEURS `bn_in` test, several speakers:

| Decision | Choice | Why |
|---|---|---|
| Model | `bengaliAI/tugstugi_bengaliai-asr_whisper-medium` (1st place in the Bengali.AI speech recognition competition): Whisper medium (769M parameters, 24 + 24 layers, 80 mels, vocabulary 51865), Apache-2.0 | Per clip WER 18.5 %, CER 5.8 %; long-form (the clips joined, as in a recording) WER 24.8 % with the default 29 s chunks, **22.2 % with 20 s chunks** (CER 9.2 %). Same engine, DTW and word forming as the other models: no new code path in the helper. |
| File | `ggml-bengaliai-whisper-medium-q5_0.bin` from `huggingface.co/winshades/bengaliai-whisper-medium-ggml` at commit `11cf5cbd282e0e46a761093939952f74906ddce1`, 539,257,671 bytes, SHA-256 `2c64c7f1e2c8f2417ed1fe5b78c7238933c00a2cdc2ef33e7087a95475256605` | A ready ggml conversion (conversion and q5_0 only, as its card lists; its Apache-2.0 LICENSE ships with it). q8_0 (823 MB) is not better (22.6 %). |
| Id, tier | `whisper-bn-medium`, tier `bangla` ("Bangla"), `language: 'bn'` | A tier id like the others (§1 "Model ids"): a pin can change without touching transcripts. |
| Chunks | `maxChunkSeconds: 20`, passed as `--max-chunk 20` | 24.8 % → 22.2 % WER long-form. `--max-chunk` (1..29.5 s) existed as a debug option; it becomes a supported per-model argument (§14.3). |
| Language | always `--lang bn`; used only when the spoken language is Bengali | Fine-tuned on Bangla only: its own language detection cannot be trusted, and it must never make captions in another language. |
| Speed, memory | `rtf4` 0.87 (long-form, 20 s chunks; 1.2 on single short clips), `ramMB` 1200 (peak RSS about 1.2 GB), load 0.4-0.7 s, `partSeconds` 180 (as turbo) | On a 4-core Windows PC (3 threads, × 1.65) a 20-minute recording takes about 29 min (`estimateSeconds`): slower than the recording, which the tab says before starting (§7.1). |
| Gating | `minTotalMemGB: 8`, `needsStandardBuild: true` (as turbo) | `memoryNeedMB` 1,262 MB; the compatible build is about 4.3 times slower (`COMPAT_FACTOR`): about 6 times the recording's length. |
| Word timings | unchanged (DTW preset MEDIUM from the header) | Word starts 91-93 % within 200 ms of forced alignment, median 40 ms, monotonic, no overlaps. |
| Text | Bengali transcripts are NFC-normalised (`localTranscript`) | Byte tokens can leave a vowel sign in two parts (ে + া for ো). Other languages are left exactly as before (NFC would also change CJK compatibility ideographs). The model writes no punctuation. |
| Hosting | the third-party file, pinned by commit, size and SHA-256 | If it disappears, downloads fail cleanly with `missing`; Qbexel can re-host the same bytes (same SHA-256) under its own Hugging Face account and change one repository in the catalog. |

### 14.2 Data model (additive) and old data

- `catalog.ts`: `SpeechModelId` and `SpeechTier` gain `'whisper-bn-medium'` and `'bangla'`
  (`SPEECH_TIER_NAMES.bangla = 'Bangla'`); `SpeechModelSpec` gains optional `language` (the one
  language a model makes captions in), `maxChunkSeconds` and `repo` (`{ repo, commit }`, absent:
  `SPEECH_MODEL_REPO`); `SpeechLicense.name` widens to `'MIT' | 'Apache-2.0'`. The entry is last in
  `SPEECH_MODELS`. New: `isLanguageModel(spec)`, `BANGLA_MODEL`, `isBengali(language)`.
  `modelUrl` uses the model's own repository (the test base still replaces it).
- **Never the default model.** `defaultModel` (speech.json, Settings' radios, E-01, the chips'
  fallback) only ever names a general model: `sanitizeSpeechSettings` maps a language model to
  base, a finished download of one never becomes the default, removing the default picks the next
  general model, `setDefault` refuses it, `localModel` and `quickerModel` skip it, and the Captions
  tab does not call `setDefaultSpeechModel` after its download. So "Detect automatically",
  English and every other language never use it.
- `speech.json` keeps its shape (`verified` and `measured` accept the new id like any catalog
  id). Flown 0.4.0 reading a newer speech.json drops the unknown id and ignores the unknown file
  in the folder (§4). A Bangla transcript is `{ provider: 'local', model: 'whisper-bn-medium',
  language: 'bn' }`; 0.4.0 shows the id where the name would be, nothing else changes. Projects and
  settings written before load unchanged.
- The part cache key already holds the model's SHA-256 and the language, so Bangla parts never
  mix with others; `ENGINE_VERSION` is unchanged (the helper's output did not change).
- Renderer session state (`speechState.ts`): the Captions tab's Spoken language moves into this
  module (`spokenLanguage()`, `setSpokenLanguage()`; session-only, as before) so Polish reads the
  same choice; Bengali has its own session chip choice (picking Standard for Bengali does not
  change the choice for other languages, and the reverse).
- `TranscribeOptions` is unchanged. `validateTranscribeOptions` refuses a language model with
  another language ("Bangla (Bengali.AI Whisper medium) makes captions in Bangla only."); without
  a language, main uses the model's own.

### 14.3 Frozen contracts extended (additively; recorded here)

- `catalog.ts` (above); `errors.ts`: `quickerModel` returns null for a language model;
  `transcriber.ts`: `localModel` skips language models, new `localModelFor(speech, language)`,
  `pickTranscriber` gains an optional 4th parameter `language` (default '': today's behaviour
  exactly); `api/speech.ts`: the licence type only.
- `protocol.ts` (§5.2): `SIDECAR` is unchanged; new `MAX_CHUNK_RANGE = { min: 1, max: 29.5 }` (the
  helper's own bounds) and `chunkArgs(spec)`: `['--max-chunk', '20']` for a model that sets
  `maxChunkSeconds`, `[]` otherwise (the helper's default stays `SIDECAR.maxChunk`, 29 s);
  `localTranscript` NFC-normalises Bengali text. The helper's usage line lists `--max-chunk S` as a
  supported `transcribe` option instead of "debug only", with a cargo test of its bounds.
- `polish.ts`: `polishTranscriber(providers, speech, remembered, language?)` returns
  `{ providerId, model?, language? }`; `language` is set only for a language model.

### 14.4 Behaviour, UI and copy

**The model for a spoken language** (`localModelFor`, pure): with the spoken language Bengali
(`bn` or `bn-*`) and the Bangla model installed and allowed here, the Bangla model; otherwise
`localModel`'s pick, as before. `pickTranscriber(…, language)` uses it, so with Bengali chosen
and the Bangla model downloaded On this PC is the default even when a key provider exists (step 2,
"an installed model"); without it nothing changes.

**The Captions tab** (On this PC chosen):

- The chips gain **"Bangla · 539 MB"** / **"Bangla · Downloaded"** (accessible names "Bangla, 539
  megabyte download" / "Bangla, downloaded") only while the Spoken language is Bengali and the
  model is allowed here. For Bengali it is the chosen chip unless the user picked another one for
  Bengali this session. Its purpose line: "Made for Bangla: far fewer mistakes than the other
  tiers, which get most Bangla words wrong."
- **The recommendation** is the `needs-model` card for the Bangla model. Title "Make Bangla
  captions on this PC"; body "Recommended for Bangla: the Bangla model gets about 4 in 5 words
  right, where the other tiers get most Bangla words wrong. Free and private: it runs on this PC
  and works offline once downloaded; the sound never leaves this PC. Flown first downloads it once
  (539 MB, from Hugging Face) and checks it before use. Then this {length} recording takes
  {estimate}."; the one primary button **"Download Bangla model (539 MB) and make captions"**
  (accessible name "Download Bangla (Bengali.AI Whisper medium), 539 megabytes, and make
  captions"); "Make them now with {tier} (downloaded)" when a general model is downloaded, as
  today; small print "Bengali.AI Whisper medium, Apache-2.0 licence ·
  huggingface.co/winshades/bengaliai-whisper-medium-ggml". The size is the exact file's (539 MB,
  `sizeWords`), like every size in the app. Downloading, stopped (Cancel keeps the part; Delete),
  verifying, the failures and the disk and offline lines are §7.2's, naming "Bangla (Bengali.AI
  Whisper medium)". Once verified, captions start with `--lang bn`; the model does not become the
  default (§14.2).
- **Bengali with another chip picked**: "For Bangla, choose Bangla: it makes far fewer mistakes."
  (`data-testid="bangla-hint"`) instead of the general "Smaller models…" line.
- **Bengali, not allowed here**: "The Bangla model is not offered on this PC: {modelBlockReason}"
  (for example "Needs about 1.3 GB of memory and a PC with 8 GB in all; this one has 4 GB.");
  the general chips and lines as before.
- **Bengali with an AI provider chosen** (a key user; nothing switches by itself, as in §7.1):
  "For Bangla, the Bangla model on this PC makes far fewer mistakes, free and offline." [Use the
  Bangla model] (`data-testid="bangla-key-hint"`), which chooses On this PC, where the
  recommendation above shows.
- **Detect automatically with the Bangla model downloaded**: "Speaking Bangla? Choose Bengali to
  use the Bangla model." [Choose Bengali] (sets the Spoken language). Detection never switches
  models by itself.
- **The last local run detected Bengali** (the summary of a local transcript in `bn` made with a
  general model, the Bangla model allowed here; `data-testid="bangla-offer"`): "Bangla captions:
  the Bangla model gets about 4 in 5 words right, where the other tiers get most Bangla words
  wrong. It runs on this PC and works offline once downloaded." with one button, **"Download
  Bangla model (539 MB) and make captions"**, or "Make them again with Bangla (downloaded)" once
  it is here. The click asks the replace question, sets the Spoken language to Bengali, opens the
  form (where the download shows) and starts. For Bengali it replaces the "Smaller models…" line.
- The memory warning covers the Bangla tier: "Bangla needs about 1.3 GB of free memory; this PC
  has {free} free right now. Close other apps first."

**Settings › Captions on this PC**: a row after the general models, "Bengali.AI Whisper medium ·
Bangla only", without a radio (it is never the model for new captions) and without "Recommended";
facts, status and actions as the other rows (Download 539 MB, Cancel, Continue, Delete, Remove,
the blocked reason); purpose "Bangla only: used whenever the spoken language is Bengali, never for
other languages. Far fewer mistakes in Bangla than the other models."; licence line (from the
catalog's licence) "Bengali.AI Whisper medium (Apache-2.0 licence) by Bengali.AI (the tugstugi
team), fine-tuned from OpenAI Whisper; converted to ggml by WinShades ·
huggingface.co/winshades/bengaliai-whisper-medium-ggml (11cf5cb)".

**Polish in one click** uses the Bangla model when the Captions tab's Spoken language is Bengali
(this session) and the model is downloaded and allowed here, passing `language: 'bn'`; its
Captions row says "Runs on this PC with the Bangla model: nothing is uploaded and it costs
nothing." Otherwise it behaves as before (no language passed, the general model).

**Main**: `localSpeechClient` passes the model's language (`--lang bn`) and `chunkArgs(spec)`;
everything else (parts, cache, retries, the time limit from `estimateSeconds`, speed learning) is
the common path.

**Notices**: `resources/notices/14-bengaliai-whisper.txt` names the model, its source revision
(`da605cc1bd2f60a18d8e440e977ddfa921a88e63`), the converted file's repository, commit and SHA-256,
the converter's changes and the Apache License 2.0 (whose full text the notices file already
holds); `NOTICE_NAMES` gains "Bengali.AI", so verify-dist checks it.

### 14.5 Risks

1. **Speed**: slower than real time on most 4-core PCs (about 29 min for 20 min); shown before
   starting (the estimate and the slow-PC line), resumable by parts, gated off the compatible
   build.
2. **Third-party hosting**: pinned; a vanished file fails as `missing`; re-hosting the same bytes
   under Qbexel's account is a one-line repository change.
3. **Bangla only**: English phrases inside a Bengali recording come out in Bangla script or are
   dropped; the summary names the model.
4. **No punctuation**, as the model was trained; Fix text with an AI provider can add it.
5. **Measured on read speech** (FLEURS): conversational and noisy recordings will do worse.
6. **Windows** speed and memory are not measured (as §9 risk 3).
7. **The Spoken language is per session**, as before: after a restart a Bengali user chooses
   Bengali again (the "Speaking Bangla?" line offers it in one click); Polish uses the Bangla model
   only after that choice.

### 14.6 Tests

- Unit, each failing without its code: the catalog pin (id, tier, file, bytes, SHA-256, the
  repository and commit URL, Apache-2.0, `language`, `maxChunkSeconds`, gating, last in the
  catalog); the default rules (sanitize, download, remove and setDefault never make a language
  model the default); `localModel`, `localModelFor`, `pickTranscriber` with a language,
  `quickerModel`; `chunkArgs` and the arguments `localSpeechClient` passes (`--lang bn --max-chunk
  20`, none for the other models); `validateTranscribeOptions`; NFC for Bengali only; the copy;
  the tab's choice by language (the chip only for Bengali and chosen by default, its own session
  choice, the blocked line, the detect line, the key users' link, the offer in the summary, no
  `setDefaultSpeechModel` after its download); the Settings row without a radio; Polish's choice and hint; the notices
  entry; the benchmark script's pin equals the catalog's.
- End to end (`tests/e2e/bangla-captions.e2e.cjs`, no 540 MB download): Bengali shows the Bangla
  chip and the recommendation with its size; the click downloads from the mock (a sparse stand-in
  of the pinned size, served slowly); Cancel keeps the part, Delete removes it; English shows no
  Bangla chip; a project whose local captions were detected as Bengali shows the offer; Settings
  lists the row "Bangla only" without a radio. The run path: a verified record for a sparse
  stand-in (the state a finished download leaves) makes the tab ready; Generate starts the real
  helper through a logging wrapper with `--model ggml-bengaliai-whisper-medium-q5_0.bin --lang bn
  --max-chunk 20`, the helper refuses the stand-in as a damaged model, and the tab offers
  "Download again (539 MB)". The pin is never bypassed, so a real Bangla run is not faked in the
  suite.
- Opt-in benchmark (not a test): `npm run bench:bangla -- --model <file>` runs the real model
  through the helper with the app's arguments on the committed fixture
  `tests/fixtures/speech/bn-fleurs-blog-18s.flac` (18.8 s, FLEURS, CC BY 4.0) and prints WER, CER
  and the RTF.
