# ssw-speech: the speech helper (offline captions and the speech detector)

`ssw-speech` is a small Rust sidecar around whisper.cpp 1.8.3 and ggml 0.9.5 (MIT), which the
crate `whisper-rs-sys = "=0.15.0"` (Unlicense) vendors and builds with CMake. It is used as raw
FFI, without the `whisper-rs` wrapper. The app spawns it as a short-lived child process that
speaks JSON lines on stdout; it is never a Node addon and never loads into the app's processes.

Design and the frozen protocol: `docs/design/offline-captions.md` (§2 engine and builds, §5.2 the
sidecar protocol, §6 packaging). That document is authoritative.

## Layout

The crate implements the frozen protocol line for line (`cpu | vad | transcribe`):

| Module | What |
| --- | --- |
| `main.rs` | subcommands, the engine glue (whisper.cpp through raw FFI), the stdin control thread |
| `args.rs` | the command line, read with `args_os` (paths stay UTF-16 clean on Windows); model names `[A-Za-z0-9._-]+` |
| `protocol.rs` | JSON lines (escaping, lossy UTF-8, finite numbers), the 15 s heartbeat, the last-line and cancel rules |
| `wav.rs` | 16 kHz mono WAV (s16 or f32) and f32le on stdin; anything else is error `audio` |
| `loader.rs` | models opened by Rust and handed to whisper.cpp through `whisper_model_loader` (non-ASCII paths); a cut file is error `model`; the model header (kind, DTW preset) |
| `vad.rs` | the speech detector: probabilities in 300 s windows with 2 s of overlap; whisper.cpp's own segments for `transcribe` |
| `chunks.rs` | speech packed into chunks of at most 29 s with their 0.25 s padding, never past the middle of a gap |
| `words.rs` | word forming from DTW token times and the per-chunk refinement (pull-in with the running median, onset snap, monotonic across chunk joins) |
| `lang.rs` | the language detected once, on the first chunk with 10 s of speech, else the one with the most |
| `guard.rs` | below-normal priority, the parent watch, Windows mitigations, `PR_SET_NO_NEW_PRIVS`/`PR_SET_PDEATHSIG`, the CPU probe and the standard build's CPUID check, peak memory |

A `cancel` line or the end of stdin (with `--stdin-control`) ends the run at once from the control
thread: the `cancelled` line carries the end of the last chunk whose segment lines are out, and the
process exits with code 2 through `_exit` (the helper writes no files, so nothing is left half
done; whisper.cpp itself checks its abort flag only between encoder passes, and never during
language detection).

`cargo test` (Linux) covers the arguments, the WAV reader, the chunk plan, word forming on token
tables, the per-chunk refinement against the recorded run in `tests/data/`, the language-chunk
choice, the heartbeat timer, JSON escaping, the windowed detector against a whole-buffer run and the
loader at a non-ASCII path. The tests against the built helper are `tests/native/*.spec.ts`
(`npm run test:native`) and `scripts/smoke-speech-wine.sh`; see `docs/BUILDING.md`.

## Building

`scripts/build-native.mjs` does all of this (`npm run build:native`, `npm run build:speech-host`).

- **Linux (tests):** `GGML_NATIVE=OFF cargo build --release` (59 s from clean, 1.62 MiB). With
  NATIVE off on a non-cross build, ggml enables SSE4.2, AVX, AVX2, FMA, F16C and BMI2.
- **Windows x64 from Linux:** `bench/build-win.sh` (32-40 s from clean, 3.42 MiB, imports only
  KERNEL32, ADVAPI32, msvcrt, ntdll and api-ms-win-core-synch-l1-2-0):
  1. the POSIX-thread MinGW (`x86_64-w64-mingw32-gcc-posix` / `g++-posix`) for CC, CXX and the
     linker (the win32-thread GCC 13 libgcc fails with `__mingwthr_key_dtor`);
  2. `CMAKE_PROJECT_INCLUDE=compat/mingw_lib_prefix.cmake` (ggml names its MinGW libraries
     `ggml.a`; rustc wants `libggml.a`);
  3. `CFLAGS_x86_64_pc_windows_gnu="-include compat/mingw_compat.h"` (mingw-w64 11 lacks
     `THREAD_POWER_THROTTLING_STATE`);
  4. `GGML_NATIVE=OFF` and `GGML_SSE42/AVX/AVX2/FMA/F16C/BMI2=ON` (cross builds turn every x86
     extension off otherwise: 7.5x slower under wine); the compatible build sets them all OFF;
  5. `build.rs`: `-ladvapi32` as a link argument, `-static -static-libgcc -static-libstdc++`, and
     the static `libstdc++.a` copied into an OUT_DIR search path;
  6. whisper-rs-sys's build script ignores changed environment variables: use a separate
     `CARGO_TARGET_DIR` per build (standard, compatible) or `cargo clean -p whisper-rs-sys`.
- Toolchain: Rust 1.88 or newer, cmake 3.28, clang/libclang 18 (bindgen), mingw-w64 (posix).

## bench/

The spike's scripts, kept for re-measuring (paths inside still point at the spike's layout; adjust
`S`, `B` and `M` before running): `fetch_models.sh` (pinned, resumable, SHA-256-checked downloads
from Hugging Face), `fetch_speech.py` (the 105.7 s LibriSpeech clip, CC-BY-4.0, with
forced-aligned word times from the HF datasets-server), `bench.py` (wall, CPU, peak RSS),
`eval_words.py` (WER and word-timing error), `eval_long.py`, `worst.py`, `cancel_test.py`,
`run_all.sh`, `build-win.sh`.

The word-timing gate (workstream A, §10.2) runs on the helper's own lines:

```bash
python3 -I bench/fetch_speech.py /tmp/bench 105          # clip.wav and truth.json (105.7 s)
../bin/ssw-speech transcribe --model-dir <dir with ggml-base-q5_1.bin> --model ggml-base-q5_1.bin \
  --audio /tmp/bench/clip.wav --vad-model ../../resources/speech/ggml-silero-v6.2.0.bin --threads 4 > run.jsonl
python3 -I bench/eval_stream.py /tmp/bench/truth.json run.jsonl
```

Pass: `segment_words` start median at most 50 ms and at least 90 % within 200 ms.
