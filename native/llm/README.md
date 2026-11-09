# ssw-llm: the text helper of AI on this PC

`ssw-llm` is a small Rust program around llama.cpp, the way `ssw-speech` is around whisper.cpp.
The app starts it as a child process, sends one request at a time as JSON lines on stdin and reads
progress and the answer as JSON lines on stdout. It is never a Node addon and never loads into the
app's processes.

Design: `docs/design/smart-tools.md` §9 (AI on this PC), §0 decision 1 (a bundled helper, one AVX2
build), §16 (security). That document is authoritative.

## What it is built from

| Crate | Version | Crate SHA-256 | Notes |
| --- | --- | --- | --- |
| `llama-cpp-2` | `=0.1.161` | `7e5249e590eab4a5015ba35cf078a4548b941e841ef8024310c3a10b2edb7179` | `default-features = false`: no `openmp` (no `libgomp-1.dll`), no `android-shared-stdcxx`; `mtmd` and `llguidance` stay off |
| `llama-cpp-sys-2` | `0.1.161` | `e9bea77fde41bbc15a278891cd5edd2ba07c5260d162614b41080ba1f100b39b` | vendors llama.cpp and its ggml (MIT) and builds them with CMake |

Both crates were published from llama-cpp-rs commit `e7af607ebd5ec2932709ef918c17cca2f9b0fce4`
(their `.cargo_vcs_info.json`). At that commit `llama-cpp-sys-2/llama.cpp` is the llama.cpp
submodule at commit **`d81235049384534c167caea52b85a694f6103d14`** (read with
`git ls-tree e7af607e llama-cpp-sys-2/llama.cpp` in llama-cpp-rs). Its `src/llama-arch.cpp` lists
`qwen35` and `gemma4`, the architectures of the two pinned models.

`Cargo.lock` is committed and every build runs with `--locked`. `serde_json` reads and writes the
JSON lines. `resources/notices/11-llama-cpp.txt` carries llama.cpp's notices (the ggml authors,
the Mozilla Foundation's sgemm kernels, YaRN's authors, ggllm.cpp) and `scripts/notices.mjs` lists
every crate linked in (`npm run notices -- --check` fails when one is missing).

### `common` is compiled but not linked

`llama-cpp-2` 0.1.161 depends on `llama-cpp-sys-2` with its default features, and `common` is one
of them, so Cargo builds llama.cpp's `common/` (and its vendored HTTP client) whatever this
manifest says. The helper calls nothing from it: with `llama-cpp-2`'s own `common` feature off,
its grammar sampler is llama.cpp's `llama_sampler_init_grammar`, and a static link takes only the
objects that are referenced. The import check proves it on every build: no `WS2_32.dll`.

If that check ever fails, the helper is built against a `[patch.crates-io]` copy of `llama-cpp-2`
0.1.161 in `native/llm/vendor/llama-cpp-2/` whose one change is in its `Cargo.toml`:

```diff
 [dependencies.llama-cpp-sys-2]
 version = "0.1.161"
+default-features = false
```

## Building

`scripts/build-native.mjs` does all of this (`npm run build:native`; `node
scripts/build-native.mjs --llm-host` for the host build the tests use).

- **Windows x64 from Linux** (`native/bin/ssw-llm.exe`): the POSIX-thread MinGW
  (`x86_64-w64-mingw32-gcc-posix` / `g++-posix`) for CC, CXX and the linker; the speech helper's
  MinGW fixes (`native/speech/compat`: `CMAKE_PROJECT_INCLUDE=mingw_lib_prefix.cmake`, since ggml
  names its MinGW libraries `ggml.a`; and `-include mingw_compat.h`, since mingw-w64 11 lacks
  `THREAD_POWER_THROTTLING_STATE` and Windows 11 would otherwise park the threads); `build.rs`
  links libstdc++, libgcc and winpthreads statically. The `GGML_*` variables, which
  `llama-cpp-sys-2`'s build script forwards to CMake, force SSE4.2, AVX, AVX2, FMA and F16C on and
  everything newer off (`LLM_GGML_FLAGS` in `scripts/lib/packaging.cjs`). CPU only.
  Measured: 7,306,240 bytes, 2,042,374 bytes with brotli (quality 11), 2,007,376 with xz; it
  imports `KERNEL32`, `ADVAPI32`, `msvcrt`, and `ntdll` and `api-ms-win-core-synch-l1-2-0` from
  Rust's standard library (as the speech helpers do). 2 minutes 13 seconds from clean on 2 cores.
- **Linux (tests):** `GGML_NATIVE=OFF CARGO_TARGET_DIR=target/host cargo build --release
  --locked` (`native/llm/target/host/release/ssw-llm`).
- `cargo test --release --locked` runs the protocol's unit tests and `tests/cli.rs` (arguments,
  bad lines, the end of stdin, the parent watch) against the built helper, without a model.

## The program

```
ssw-llm [--low-priority] [--parent-pid <pid>] [--verbose]
ssw-llm tokens --model <file>
```

- `--low-priority`: below-normal priority (set before any thread starts). `--parent-pid`: exits
  when that process ends (Linux: `PR_SET_PDEATHSIG`; Windows: a wait on its handle). Windows
  process mitigations and `PR_SET_NO_NEW_PRIVS` as in the speech helper.
- stdin is read on its own thread: `cancel` marks a request id, checked between batches of 64
  prompt tokens and before each token written; the end of stdin ends the process at once with
  `_exit`, even in the middle of a request.
- The protocol (`src/protocol.rs`, `src/shared/localAi/protocol.ts`): `load` (model path, context,
  threads, `mmap`), `run` (id, the chat as parts, a GBNF grammar, `maxTokens`, temperature, top-p,
  seed), `cancel`; events `loaded`, `read`, `write`, `done` (at most 256 KB of text), `cancelled`,
  `error` (`context`, `model`, `memory`, `internal`). Every input line is read strictly: an
  unknown key, op or a value out of range is an `error` line and changes nothing.
- Each part is tokenized on its own, with special-token parsing only in parts marked `special`
  (the chat template's own pieces, which the app writes); the model's beginning-of-text token is
  added to the first part when it asks for one. The helper never reads the GGUF's chat template.
- Sampling: top-k 40, top-p, temperature, then a seeded draw, under the grammar. A token is drawn
  without the grammar first and kept when the grammar allows it; only otherwise is the grammar
  applied to the whole vocabulary (as llama.cpp's own sampler does), which keeps a 262k-token
  vocabulary fast.
- It reads only the model file the app names and its stdin, writes only stdout and stderr, opens
  no port and makes no file. One model a process: the app starts a new helper for another model.
- `tokens --model <file>` (tests only): reads one line `{"parts":[…],"grammar"?:…,"text"?:…}` and
  prints the token ids, how many are control or user-defined tokens, and whether llama.cpp's
  grammar engine accepts `text` (`tests/llmHelper.test.ts`, §22 tests 66, 68 and 80).

## Tests with a model

`tests/llmHelper.test.ts` runs the real helper when `SSW_LLM_TEST_MODEL` names a GGUF file. The
tests never download the 1.3 to 3.1 GB catalogue models: they use llama.cpp's own tiny test model,
`stories260K.gguf` (1,185,376 bytes, SHA-256
`270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d`, from
`https://huggingface.co/ggml-org/models-moved/resolve/499bc8821c6b12b4e53c5bffcb21ec206f212d81/tinyllamas/stories260K.gguf`).
`SSW_LLM_TEST_HELPER` names the helper (default: the host build in `native/llm/target/host`).

Under wine the Windows build answers the same request with the same text as the host build.
