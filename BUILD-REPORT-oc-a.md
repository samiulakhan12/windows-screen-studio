# Build report: offline captions, workstream A (native engine, build, packaging, notices, test assets)

Branch `feat-oc-a`, from `2011f42` (the approved spec `docs/design/offline-captions.md` and the
frozen contracts). Only workstream A's files changed (§12 "Work split"); no frozen file and no
exported signature was touched.

## What was built

**The speech helper** (`native/speech`), rebuilt from the spike to the frozen protocol
(`src/shared/speech/protocol.ts`, §5.2):

| Module | What |
| --- | --- |
| `main.rs` | `cpu`, `vad`, `transcribe`; whisper.cpp 1.8.3 through raw FFI (`whisper_init_with_params_no_state` through the loader, one `whisper_init_state`, greedy, `flash_attn = false`, DTW preset from the model header, `token_timestamps = false`, logs silenced unless `--verbose`); the stdin control thread |
| `args.rs` | `args_os` parsing; unknown flags, flags of another subcommand, repeated flags and model names outside `[A-Za-z0-9._-]+` (or `.`/`..`) are error `args`; debug flags `--dtw --beam --prompt --max-chunk --verbose` |
| `protocol.rs` | JSON lines (control characters escaped, lossy UTF-8, numbers always finite with three decimals), the 15 s heartbeat, the "last line" rule (nothing after `result`/`error`) and the immediate cancel |
| `wav.rs` | 16 kHz mono WAV s16/f32 (extensible too), f32le on stdin; anything else is `audio` |
| `loader.rs` | `whisper_model_loader` over `std::fs::File` (Unicode paths); short reads zero-filled and flagged, so a cut model is error `model`, never a crash; the ggml header (kind, multilingual, DTW preset) |
| `vad.rs` | Silero on one thread; `vad` streams stdin in 300 s windows (9375 frames) with 63 frames (2.016 s) of overlap, stitched at the middle of the overlap; one byte per 32 ms frame, base64; `transcribe` uses whisper.cpp's segments on the whole part with `max_speech_duration_s` 28 s |
| `chunks.rs` | speech packed into chunks of at most 29 s including the 0.25 s padding, padding never past the middle of a gap; an over-long range is cut |
| `words.rs` | raw words from token tables (eot filter, space-led tokens, bytes joined then decoded, end at the last letter/digit token's `t_dtw`), then per chunk before printing: pull-in with the run's median so far, onset snap, monotonic across chunk joins |
| `lang.rs` | detection once on the first chunk with ≥ 10 s of speech, else the most speech (`whisper_pcm_to_mel_with_state` + `whisper_lang_auto_detect_with_state`); `language_s`; '' without speech; `--lang xx` checked with `whisper_lang_id` (error `language`) |
| `guard.rs` | `--low-priority` (BELOW_NORMAL / nice 10, before any thread), parent watch (`OpenProcess` + wait on Windows, `PR_SET_PDEATHSIG` + `getppid` check on Linux), `PR_SET_NO_NEW_PRIVS`, Windows mitigations for extension points and image loads (looked up at run time, failures logged), the CPU probe, the standard build's CPUID check at the start of `main` (error `cpu`), peak memory through `K32GetProcessMemoryInfo` (looked up in kernel32 at run time) or `getrusage` |

`build.rs` derives the build name (`standard` / `compatible` / `host`, for the `ready` line and the
CPUID check) from `SSW_SPEECH_BUILD` or the ggml flags.

**Build and packaging:** `scripts/build-native.mjs` (capture helper, then the standard and
compatible Windows builds in `native/speech/target/{standard,compat}` with the POSIX MinGW,
`CMAKE_PROJECT_INCLUDE`, the forced-include header and the `GGML_*` flags; `--speech-host`;
missing cmake/libclang/posix MinGW warn and skip unless `--require`/`SSW_REQUIRE_NATIVE=1`; prints
each exe's imports), `scripts/lib/pe.cjs` `readImports` (import and delay-load directories),
`scripts/lib/packaging.cjs` (`speechHelpers`, `speechHelperStatus`, `speechResources`,
`noticesResource`, `SPEECH_IMPORTS`, `SPEECH_BUDGET`, `VAD_PIN`, `noticesProblems`),
`electron-builder.config.cjs` (the three extraResources entries of §6.2 in directory form; nothing in
asar or asarUnpack; `SIGN_EXTS` unchanged), `scripts/predist.mjs` (helpers, model pin, notices
`--check`), `scripts/verify-dist.mjs` section 4b (x64 PEs, the import allow-list, the model pin,
the notices, the speech payload budget with brotli q11/16 MB window; no whole-installer baseline).

**Notices:** `scripts/notices.mjs` (`npm run notices [-- --check]`) from `resources/notices/*.txt`
(whisper.cpp/ggml, Silero VAD, OpenAI Whisper weights, mingw-w64 runtime and winpthreads, GCC
runtime exception, FFmpeg, Electron/Chromium, MediaPipe), `cargo metadata` of both crates (normal
dependencies for x86_64-pc-windows-gnu, proc macros excluded) and the npm packages that ship or are
bundled (runtime packages, the dependency closure of React, MediaPipe and the three AI SDKs, and
Electron; type-only packages excluded); identical licence texts are printed once. Output
`resources/THIRD_PARTY_NOTICES.txt`, committed.

**Test assets and tests:** `scripts/fetch-test-speech.mjs` (pinned, resumable, SHA-256 checked,
reused; honours `HTTPS_PROXY` through `NODE_USE_ENV_PROXY`), `vitest.native.config.ts`,
`tests/native/speech.spec.ts`, `scripts/smoke-speech-wine.sh`, `tests/packaging.test.ts` (new
speech section, `readImports`, the config's extraResources), `tests/e2e/packaging.e2e.cjs` (asserts
verify-dist ran the speech checks), `package.json` scripts `build:speech-host`, `notices`,
`fetch:test-speech`, `test:native` (no new dependency), docs (`docs/BUILDING.md` "The speech
helper", `native/README.md` pointer, `native/speech/README.md`, `tests/fixtures/speech/README.md`).
`.gitignore` already covered `/.cache/` and `native/speech/target/`; no model other than the
committed speech detector is in the repository and no build output is committed.

## Deviations and why

1. **Windowed speech detector probabilities cannot equal whole-buffer ones within 0.02** (§10.2).
   whisper.cpp resets Silero's LSTM state at the start of every `whisper_vad_detect_speech` call,
   and that state never converges to a long run's: measured on JFK + LibriSpeech, a restart still
   differs by 0.05-0.07 twenty seconds later and by up to 0.3-0.5 near onsets, for any window or
   overlap size (10 % of frames off by more than 0.02). Determinism is not the issue (the same call
   twice, a fresh model and a prefix all give identical values). The cargo test therefore checks
   what consumers use: frame decisions (Silero's hysteresis, 100 ms bridging, 250 ms minimum)
   agree on ≥ 98 % of frames (measured 1238 of 1250) and the ranges, after joining pauses under
   `ACTIVITY.hold` (0.5 s), agree within 5 frames (160 ms). A short dip can split a range in one run
   and not the other; voice.ts joins across 0.5 s and the director across 1.0 s, so this does not
   reach a consumer. `test:native` adds an 11-minute stream with utterances straddling both window
   joins: every utterance is found, nothing else is. The design's sentence "windows stitch
   trivially" should be read as "within a frame or two at the range level".
2. **Cancel is immediate.** The spike cancelled "at the next checkpoint", but whisper.cpp checks its
   abort flag only after a whole encoder pass and never during language detection: under wine the
   first smoke run measured 1.05 s. The control thread now prints the `cancelled` line itself and
   leaves through `_exit(2)` (no atexit handlers or C++ static destructors while engine threads
   compute; the helper writes no files). `done_until` is the end of the last chunk whose segment
   lines are out. Measured under wine: 14 ms to exit, the line after 1 ms. A cancel or heartbeat
   after the `result`/`error` line is ignored.
3. **JFK alone holds 7.9 s of speech**, so it cannot give `language_s ≥ 10`. The native tests that
   assert `language_s ≥ 10` transcribe JFK + 0.5 s + the LibriSpeech clip (13 s of speech, as the
   end-to-end fixture joins them); the "1 s of JFK, 40 s of silence, JFK again" case also appends
   the LibriSpeech clip, and asserts detection on that chunk (`language_s` between 10 and 20).
4. **Chunks are at most 29 s including padding** (packing limit 28.5 s), and the detector splits
   continuous speech at 28 s (`max_speech_duration_s`), so no chunk exceeds whisper's window. The
   spike packed 29 s and then padded (up to 29.5 s). On the recorded clip the grouping is identical.
5. **Smaller choices:** `ready.dtw` uses the §5.2 spelling ("BASE", "TINY", "LARGE_V3_TURBO", "off");
   besides whisper.cpp's callback, a progress line is printed at the start (0 %) and after each chunk;
   segments without words are not printed; a model that cannot be opened is error `model`; an
   English-only model always uses "en" (`language_s` 0); `cpu` never runs the CPUID check (only
   `vad`/`transcribe` of the standard build do); a `vad` line that would exceed 1 MB (about 7 hours)
   is error `audio` instead of a protocol violation; `--speech-host` fails when it cannot build
   (it was asked for explicitly); verify-dist notes, rather than fails, a missing speech helper
   unless `SSW_REQUIRE_NATIVE=1` (like the capture helper).
6. **Speed in this container.** Base q5_1 with 4 threads ran at RTF 0.106-0.125 here, not the
   reference 0.079; the spike's own binary, rebuilt from `2011f42`, measured 0.116-0.126 on the same
   machine and clip, so this container is slower, not the helper. Catalog numbers were not changed.
7. **Toolchain installed:** `rustup target add x86_64-pc-windows-gnu`, `mingw-w64` (posix and win32
   variants), `wine64`, `wine32:i386` (electron-builder runs the 32-bit NSIS installer under wine;
   docs already listed it), `openbox`, `xvfb`. cmake 3.28.3, clang/libclang 18, Rust 1.97 were present.
   The smoke script sets `LANG=C.UTF-8`: under the C locale wine mangles non-ASCII paths before
   the helper sees them (the helper itself opened them fine once wine passed them on).
8. **Contracts:** nothing in the frozen files is wrong for workstream A; no workaround was needed.
   Notes for B: `cancelled.done_until` is the end of the last chunk printed (0 before any); every
   printed segment has at least one word; `result` is always the last line of a successful run;
   the helper exits 2 through `_exit`, so a kill after `cancel\n` usually finds it gone.

## Verification (all run here, outputs abridged)

| Check | Result |
| --- | --- |
| `cargo test` (native/speech) | `test result: ok. 38 passed; 0 failed`; per-chunk refinement against `tests/data/spike-base-q5_1-clip.jsonl`: **222 of 226 words identical (±1 ms), at most 120 ms apart**; language-chunk choice and heartbeat tests pass |
| `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | clean |
| `node scripts/build-native.mjs --require` | exit 0, 2 min 41 s from clean (capture + both speech builds; a host build ran alongside); prints each exe's imports |
| `node scripts/build-native.mjs --speech-host` | `native/bin/ssw-speech (1689 KB)` |
| `npm ci` | added 432 packages, 0 vulnerabilities (Electron's binary was fetched by its install script afterwards) |
| `npm run fetch:test-speech` | `.cache/test-speech/ggml-tiny-q8_0.bin (SHA-256 c2085835d3f5…, matches the catalog pin)` |
| `npm run test:native` | `Tests 10 passed (10)` |
| `scripts/smoke-speech-wine.sh` | `all checks passed` (imports, `cpu`, `vad` from WAV and stdin in a non-ASCII folder, `transcribe`, both builds heard the same 39 words, cancel: exit 2 after 14 ms) |
| `npm run notices -- --check` | `resources/THIRD_PARTY_NOTICES.txt is up to date (136431 bytes)` |
| `npm run typecheck` | clean (both projects) |
| `npx vitest run --testTimeout=60000` | `Test Files 150 passed (150)`, `Tests 2141 passed (2141)` |
| `npm run build` | built |
| Bench gate | **pass** (below) |
| `WINEDEBUG=-all SSW_REQUIRE_NATIVE=1 npm run dist:win` | verify-dist `all checks passed`; installer 118.5 MB, installed 445.1 MB; 4 min 52 s |
| `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/run-all.cjs packaging` | `1/1 e2e files passed` (window icon; verify-dist with the speech section) |

### The bench gate (§2.1, §10.2)

`bench/eval_stream.py` on base q5_1 (pinned file, SHA-256 422f1ae4…), 4 threads, detector on, the
105.7 s clip and truth from `bench/fetch_speech.py` (229 words), from the helper's own lines:

| | Median | p90 | Within 200 ms | Matched |
| --- | --- | --- | --- | --- |
| **Word starts (segment lines)** | **45 ms** | 145 ms | **92.4 %** | 211 |
| Word ends (segment lines) | 55 ms | 145 ms | 94.8 % | 211 |

Gate: start median ≤ 50 ms and ≥ 90 % within 200 ms: **passed**, and equal to the design's figures
for the spike's lines refined per chunk (45 / 145 ms / 92.4 %). No overlapping words. The run:
`language "en", language_s 17.01, load 311 ms, vad 314 ms, asr 12.05 s, rtf 0.117, peak_rss_mb 312`.

### Sizes

| File | Raw | xz -9e | Brotli (q11, 16 MB window) |
| --- | --- | --- | --- |
| `ssw-speech.exe` (standard) | 3,609,600 B | 1,019,956 B | 1,040,216 B |
| `ssw-speech-compat.exe` | 3,476,992 B | 973,280 B | 991,651 B |
| `THIRD_PARTY_NOTICES.txt` | 136,431 B | 20,852 B | 18,661 B |
| `ggml-silero-v6.2.0.bin` (for reference) | 885,098 B | 752,208 B | 772,109 B |

verify-dist's speech payload (both exes, the model, MODEL.md, the notices): **8,109,348 B installed**
(budget 10 MB), **2,087,067 B brotli as one stream** (budget 3.5 MB). The installer is 118.5 MB
against the design's 116.8 MB baseline (not re-measured on this commit without the speech files).

### Import lists

Both exes (`objdump -p`, and verify-dist's `readImports`): **api-ms-win-core-synch-l1-2-0.dll,
ADVAPI32.dll, KERNEL32.dll, msvcrt.dll, ntdll.dll**. No bcryptprimitives (allowed), no psapi, no
MinGW DLLs.

### The compatible build's speed under wine (105.7 s clip, 4 threads, wall time)

| Model | Standard | Compatible | Ratio |
| --- | --- | --- | --- |
| Whisper base q5_1 | 17.7 s (RTF 0.167) | 75.3 s (**RTF 0.712**) | 4.26 |
| Whisper tiny q8_0 | 10.8 s (RTF 0.102) | 25.0 s (RTF 0.237) | 2.3 |

The base ratio matches `COMPAT_FACTOR` (4.3). Both builds give the same words; peak memory is
reported under wine (240 MB for tiny on 17 s).

## Not verified here

Real Windows (§10.5): the process mitigations' effect (`Get-ProcessMitigation`), the parent
watch with a real Windows parent PID, Smart App Control, real speed and memory.
