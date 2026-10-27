#!/bin/sh
# Cross-compile ssw-speech for Windows x64 from Linux with MinGW-w64 (posix thread model),
# statically linked (no libstdc++/libgcc/winpthread DLLs), AVX2 baseline (GGML_NATIVE=OFF).
set -eu
crate=$(cd "$(dirname "$0")/.." && pwd)
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc-posix
export CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++-posix
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc-posix
export CMAKE_PROJECT_INCLUDE="$crate/compat/mingw_lib_prefix.cmake"
export CFLAGS_x86_64_pc_windows_gnu="-include $crate/compat/mingw_compat.h"
export GGML_NATIVE=${GGML_NATIVE:-OFF}
# ggml turns every x86 extension OFF by default when cross-compiling: ask for the AVX2 baseline
# (x86-64-v3: Haswell 2013+, Zen 1+). SSE-only CPUs would need a second build with these OFF.
for f in SSE42 AVX AVX2 FMA F16C BMI2; do eval "export GGML_$f=\${GGML_$f:-ON}"; done
cd "$crate" && cargo build --release --target x86_64-pc-windows-gnu "$@"
