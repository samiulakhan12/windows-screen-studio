# ssw-speech: the speech helper (offline captions and the speech detector)

`ssw-speech` is a small Rust sidecar around whisper.cpp 1.8.3 and ggml 0.9.5 (MIT), which the
crate `whisper-rs-sys = "=0.15.0"` (Unlicense) vendors and builds with CMake. It is used as raw
FFI, without the `whisper-rs` wrapper. The app spawns it as a short-lived child process that
speaks JSON lines on stdout; it is never a Node addon and never loads into the app's processes.

Design and the frozen protocol: `docs/design/offline-captions.md` (§2 engine and builds, §5.2 the
sidecar protocol, §6 packaging). That document is authoritative.

## State of this folder

This is the **starting point copied from the spike** that chose the engine (word timings with DTW,
VAD chunking, the MinGW static-link fixes, measured in the design document §2). Workstream A of the
design brings it in line with the frozen protocol:

- subcommands `cpu | vad | transcribe` (the spike has `info | vad | transcribe`);
- `vad` prints one probability per 32 ms frame (base64 of `uint8`), not ranges, and works in
  300 s windows with 2 s of overlap;
- `--model-dir D --model F` (F a bare catalog file name), models and the VAD model opened by Rust
  and passed to whisper.cpp through `whisper_model_loader` (non-ASCII paths on Windows);
- error lines carry a `code`; `--parent-pid`; Windows process mitigations; a CPUID check before
  any ggml code in the standard build;
- split into modules (`protocol.rs`, `wav.rs`, `loader.rs`, `vad.rs`, `chunks.rs`, `words.rs`,
  `guard.rs`) with `cargo test` coverage.

`scripts/build-native.mjs` does not build this crate yet; workstream A adds it.

## Building (what the spike proved)

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
