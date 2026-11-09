#!/usr/bin/env node
// Builds the native helpers into native/bin, where the app (development) and electron-builder
// (extraResources -> resources/native/) pick them up:
//   - the Windows capture helper (native/, Rust) -> native/bin/ssw-capture.exe;
//   - the speech helper (native/speech, Rust + whisper.cpp) twice for Windows x64:
//     native/bin/ssw-speech.exe (standard: ggml with SSE4.2, AVX, AVX2, FMA, F16C and BMI2 forced
//     on) and native/bin/ssw-speech-compat.exe (compatible: every x86 extension off, runs on any
//     x64 processor). docs/design/offline-captions.md §2.4 and §6.1;
//   - the text helper (native/llm, Rust + llama.cpp through llama-cpp-2 0.1.161, --locked) once for
//     Windows x64: native/bin/ssw-llm.exe, static MinGW, CPU only, ggml with SSE4.2, AVX, AVX2, FMA
//     and F16C forced on (one AVX2 build). docs/design/smart-tools.md §9.1.
//
//   node scripts/build-native.mjs                # warn and exit 0 when a helper cannot be built
//   node scripts/build-native.mjs --require      # fail instead (release builds/CI); also SSW_REQUIRE_NATIVE=1
//   node scripts/build-native.mjs --speech-host  # only the speech helper for this machine -> native/bin/ssw-speech
//                                                # (development and the tests; npm run build:speech-host); fails when it cannot
//
// Windows builds for the host toolchain (x86_64-pc-windows-msvc, or -gnu); Linux and macOS
// cross-compile for x86_64-pc-windows-gnu, which needs `rustup target add x86_64-pc-windows-gnu`
// and the MinGW-w64 linker (x86_64-w64-mingw32-gcc). The speech helper also needs cmake, libclang
// (bindgen) and the POSIX-thread MinGW (x86_64-w64-mingw32-gcc-posix / g++-posix), and is
// cross-compiled from Linux or macOS only (on Windows, usable ones already in native/bin are
// kept, so --require passes with them). Without the capture helper the app records through
// Chromium (with the OS cursor in the video); without the speech helper captions offer AI
// providers only and the speech detector falls back to sound levels. So a missing toolchain is
// not fatal unless --require is given.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { checkWindowsExe, readImports } = require('./lib/pe.cjs')
const { LLM_BUDGET, LLM_GGML_FLAGS, LLM_IMPORTS, llmHelperStatus, speechHelpers, speechHelperStatus, unexpectedLlmImports } = require('./lib/packaging.cjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const crate = path.join(root, 'native')
const speechCrate = path.join(crate, 'speech')
const binDir = path.join(crate, 'bin')
const required = process.argv.includes('--require') || process.env.SSW_REQUIRE_NATIVE === '1'
const speechHostOnly = process.argv.includes('--speech-host')
const llmHostOnly = process.argv.includes('--llm-host')
const llmOnly = process.argv.includes('--llm')
const llmCrate = path.join(crate, 'llm')
const WIN_TARGET = 'x86_64-pc-windows-gnu'

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts })
}

const problems = []

/** A helper could not be built: a warning, or (required) a failure reported at the end. */
function skip(what, reason, hint, consequence) {
  const lines = [`build-native: ${what}: ${reason}`]
  if (hint) lines.push(`build-native: ${hint}`)
  if (required || speechHostOnly || llmHostOnly) {
    console.error(lines.join('\n'))
    problems.push(`${what}: ${reason}`)
  } else {
    console.warn(lines.join('\n'))
    console.warn(`build-native: WARNING: skipping ${what}; ${consequence}`)
  }
  return false
}

function haveCargo(what, consequence) {
  const cargo = run('cargo', ['--version'])
  if (cargo.error || cargo.status !== 0) return skip(what, 'no Rust toolchain found (cargo is not on PATH).', 'Install Rust from https://rustup.rs.', consequence)
  return true
}

function haveTarget(what, target, consequence) {
  const rustup = run('rustup', ['target', 'list', '--installed'])
  if (!rustup.error && rustup.status === 0 && !rustup.stdout.split(/\s+/).includes(target)) {
    return skip(what, `the Rust target ${target} is not installed.`, `Run: rustup target add ${target}`, consequence)
  }
  return true
}

function copyOut(built, out) {
  mkdirSync(path.dirname(out), { recursive: true })
  copyFileSync(built, out)
  console.log(`build-native: ${path.relative(root, out)} (${Math.round(statSync(out).size / 1024)} KB)`)
}

// ----------------------------------------------------------------------- capture helper

function buildCapture() {
  const what = 'ssw-capture.exe'
  const consequence = 'the app will fall back to Chromium capture (cursor baked into the video).'
  if (!haveCargo(what, consequence)) return
  const rustc = run('rustc', ['-vV'])
  const host = /host: (\S+)/.exec(rustc.stdout ?? '')?.[1] ?? ''
  let target
  if (process.platform === 'win32') {
    target = host.endsWith('-gnu') ? WIN_TARGET : 'x86_64-pc-windows-msvc'
  } else {
    target = WIN_TARGET
    const linker = run('x86_64-w64-mingw32-gcc', ['--version'])
    if (linker.error || linker.status !== 0) {
      return skip(what, 'the MinGW-w64 linker (x86_64-w64-mingw32-gcc) is missing.', 'Install mingw-w64 (apt install mingw-w64 / brew install mingw-w64).', consequence)
    }
  }
  if (!haveTarget(what, target, consequence)) return
  console.log(`build-native: cargo build --release --target ${target} (native/)`)
  const build = run('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')], { stdio: 'inherit' })
  if (build.error || build.status !== 0) {
    return skip(
      what,
      `cargo build failed (${build.error?.message ?? `exit code ${build.status}`}).`,
      target.endsWith('-msvc') ? 'The MSVC toolchain needs the Visual Studio C++ Build Tools (or use the x86_64-pc-windows-gnu toolchain).' : undefined,
      consequence
    )
  }
  const built = path.join(crate, 'target', target, 'release', 'ssw-capture.exe')
  if (!existsSync(built)) {
    console.error(`build-native: expected ${built} after the build, but it is missing.`)
    process.exit(1)
  }
  copyOut(built, path.join(binDir, 'ssw-capture.exe'))
}

// ------------------------------------------------------------------------ speech helper

const SPEECH_CONSEQUENCE = 'captions on this PC will be unavailable (AI providers only) and the speech detector falls back to sound levels.'

/** cmake 3.28 or newer. */
function haveCmake(what) {
  const r = run('cmake', ['--version'])
  const v = /version (\d+)\.(\d+)/.exec(r.stdout ?? '')
  if (r.error || r.status !== 0 || !v) return skip(what, 'cmake is missing.', 'Install cmake 3.28 or newer (apt install cmake).', SPEECH_CONSEQUENCE)
  if (Number(v[1]) < 3 || (Number(v[1]) === 3 && Number(v[2]) < 28)) return skip(what, `cmake ${v[1]}.${v[2]} is too old.`, 'Install cmake 3.28 or newer.', SPEECH_CONSEQUENCE)
  return true
}

/** libclang, which bindgen loads to read whisper.h (LIBCLANG_PATH, llvm-config or the usual folders). */
function haveLibclang(what) {
  const dirs = []
  if (process.env.LIBCLANG_PATH) dirs.push(process.env.LIBCLANG_PATH)
  const cfg = run('llvm-config', ['--libdir'])
  if (!cfg.error && cfg.status === 0) dirs.push(cfg.stdout.trim())
  for (const base of ['/usr/lib', '/usr/lib64', '/usr/local/lib', '/usr/lib/x86_64-linux-gnu', '/opt/homebrew/opt/llvm/lib', '/usr/local/opt/llvm/lib']) {
    dirs.push(base)
    try {
      for (const d of readdirSync(base)) if (/^llvm-?\d*/.test(d)) dirs.push(path.join(base, d, 'lib'))
    } catch {
      // not there
    }
  }
  const found = dirs.some((d) => {
    try {
      return readdirSync(d).some((f) => /^(lib)?clang(-\d+)?\.(so|dylib|dll)(\.\d+)*$/.test(f))
    } catch {
      return false
    }
  })
  if (!found) return skip(what, 'libclang is missing (bindgen needs it).', 'Install clang and libclang (apt install clang libclang-dev) or set LIBCLANG_PATH.', SPEECH_CONSEQUENCE)
  return true
}

/** One cargo build of native/speech into its own target folder (whisper-rs-sys's build script ignores changed environment variables). */
function cargoSpeech(label, targetDir, args, env) {
  console.log(`build-native: cargo build --release ${args.join(' ')} (native/speech, ${label})`)
  const r = run('cargo', ['build', '--release', '--locked', ...args, '--manifest-path', path.join(speechCrate, 'Cargo.toml')], {
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: path.join(speechCrate, 'target', targetDir), GGML_NATIVE: 'OFF', ...env }
  })
  return r.error || r.status !== 0 ? `cargo build failed (${r.error?.message ?? `exit code ${r.status}`})` : null
}

/** The two Windows x64 builds (§6.1), cross-compiled with the POSIX-thread MinGW. */
function buildSpeechWindows() {
  const what = 'the speech helpers (ssw-speech.exe, ssw-speech-compat.exe)'
  if (process.platform === 'win32') {
    // Not built here: helpers built on Linux or macOS and copied to native/bin are bundled.
    const status = speechHelperStatus(root)
    // Usable, and built from these sources (an older helper lacks an option the app now passes, such as --no-timestamps).
    const current = (h) => h.bundle && !h.missingOptions.length
    if (status.every(current)) {
      console.warn(`build-native: WARNING: the speech helpers are cross-compiled from Linux or macOS only; reusing the prebuilt ${status.map((h) => h.from).join(' and ')} (not rebuilt now).`)
      return
    }
    const bad = status
      .filter((h) => !current(h))
      .map((h) => (h.bundle ? `${h.from} is from older sources (it does not know ${h.missingOptions.join(', ')})` : `${h.from} is ${h.present ? `unusable (${h.reason})` : 'missing'}`))
      .join(', ')
    return skip(what, `they are cross-compiled from Linux or macOS only, and ${bad}.`, 'Build them on Linux (see docs/BUILDING.md) and copy them to native/bin.', SPEECH_CONSEQUENCE)
  }
  if (!haveCargo(what, SPEECH_CONSEQUENCE) || !haveTarget(what, WIN_TARGET, SPEECH_CONSEQUENCE)) return
  for (const tool of ['x86_64-w64-mingw32-gcc-posix', 'x86_64-w64-mingw32-g++-posix']) {
    const r = run(tool, ['--version'])
    if (r.error || r.status !== 0) {
      return skip(what, `the POSIX-thread MinGW (${tool}) is missing.`, 'Install mingw-w64 (apt install mingw-w64 g++-mingw-w64-x86-64-posix).', SPEECH_CONSEQUENCE)
    }
  }
  if (!haveCmake(what) || !haveLibclang(what)) return
  const compat = path.join(speechCrate, 'compat')
  const common = {
    CC_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-gcc-posix',
    CXX_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-g++-posix',
    CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: 'x86_64-w64-mingw32-gcc-posix',
    // ggml names its MinGW libraries ggml.a; rustc wants libggml.a.
    CMAKE_PROJECT_INCLUDE: path.join(compat, 'mingw_lib_prefix.cmake'),
    // mingw-w64 11 lacks THREAD_POWER_THROTTLING_STATE.
    CFLAGS_x86_64_pc_windows_gnu: `-include ${path.join(compat, 'mingw_compat.h')}`
  }
  const flags = (on) => Object.fromEntries(['SSE42', 'AVX', 'AVX2', 'FMA', 'F16C', 'BMI2'].map((f) => [`GGML_${f}`, on ? 'ON' : 'OFF']))
  for (const helper of speechHelpers()) {
    const standard = helper.build === 'standard'
    // A cross build turns every x86 extension off unless asked (7.5 times slower under wine).
    const env = { ...common, ...flags(standard), SSW_SPEECH_BUILD: helper.build }
    if (!standard) Object.assign(env, { GGML_AVX512: 'OFF', GGML_AVX_VNNI: 'OFF', GGML_AMX_TILE: 'OFF', GGML_AMX_INT8: 'OFF', GGML_AMX_BF16: 'OFF' })
    const failed = cargoSpeech(helper.build, helper.build === 'standard' ? 'standard' : 'compat', ['--target', WIN_TARGET], env)
    if (failed) return skip(path.basename(helper.from), `${failed}.`, undefined, SPEECH_CONSEQUENCE)
    const built = path.join(speechCrate, 'target', helper.build === 'standard' ? 'standard' : 'compat', WIN_TARGET, 'release', 'ssw-speech.exe')
    const check = checkWindowsExe(built)
    if (!check.ok) return skip(path.basename(helper.from), `the build is not a usable x64 executable (${check.reason}).`, undefined, SPEECH_CONSEQUENCE)
    copyOut(built, path.join(root, helper.from))
    console.log(`build-native: ${path.basename(helper.from)} imports ${readImports(readFileSync(built)).join(', ')}`)
  }
}

/** The speech helper for this machine (development and tests): native/bin/ssw-speech[.exe]. */
function buildSpeechHost() {
  const what = 'the host speech helper (native/bin/ssw-speech)'
  if (!haveCargo(what, SPEECH_CONSEQUENCE) || !haveCmake(what) || !haveLibclang(what)) return
  const failed = cargoSpeech('host', 'host', [], { SSW_SPEECH_BUILD: 'host' })
  if (failed) return skip(what, `${failed}.`, undefined, SPEECH_CONSEQUENCE)
  const exe = process.platform === 'win32' ? 'ssw-speech.exe' : 'ssw-speech'
  copyOut(path.join(speechCrate, 'target', 'host', 'release', exe), path.join(binDir, exe))
}

// -------------------------------------------------------------------------- text helper

const LLM_CONSEQUENCE = 'AI on this PC will be unavailable (AI services only).'

/** One cargo build of native/llm into its own target folder, always with the lock file. */
function cargoLlm(label, targetDir, args, env) {
  console.log(`build-native: cargo build --release --locked ${args.join(' ')} (native/llm, ${label})`)
  const r = run('cargo', ['build', '--release', '--locked', ...args, '--manifest-path', path.join(llmCrate, 'Cargo.toml')], {
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: path.join(llmCrate, 'target', targetDir), GGML_NATIVE: 'OFF', ...env }
  })
  return r.error || r.status !== 0 ? `cargo build failed (${r.error?.message ?? `exit code ${r.status}`})` : null
}

/**
 * The text helper for Windows x64 (§9.1): cross-compiled with the POSIX-thread MinGW, statically,
 * CPU only; the GGML_* variables, which llama-cpp-sys-2's build script forwards to CMake, force
 * SSE4.2, AVX, AVX2, FMA and F16C on (one build: PCs without AVX2 get no AI on this PC). The MinGW
 * fixes are the speech helper's (native/speech/compat): ggml's library names, and the
 * THREAD_POWER_THROTTLING_STATE that mingw-w64 11 lacks, so Windows 11 does not park its threads.
 * Imports and size are checked here and again by verify-dist.
 */
function buildLlmWindows() {
  const what = 'the text helper (ssw-llm.exe)'
  const from = 'native/bin/ssw-llm.exe'
  if (process.platform === 'win32') {
    const status = llmHelperStatus(root)
    if (status.bundle) {
      console.warn(`build-native: WARNING: the text helper is cross-compiled from Linux or macOS only; reusing the prebuilt ${from} (not rebuilt now).`)
      return
    }
    return skip(what, `it is cross-compiled from Linux or macOS only, and ${from} is ${status.present ? `unusable (${status.reason})` : 'missing'}.`, 'Build it on Linux (see native/llm/README.md) and copy it to native/bin.', LLM_CONSEQUENCE)
  }
  if (!haveCargo(what, LLM_CONSEQUENCE) || !haveTarget(what, WIN_TARGET, LLM_CONSEQUENCE)) return
  for (const tool of ['x86_64-w64-mingw32-gcc-posix', 'x86_64-w64-mingw32-g++-posix']) {
    const r = run(tool, ['--version'])
    if (r.error || r.status !== 0) {
      return skip(what, `the POSIX-thread MinGW (${tool}) is missing.`, 'Install mingw-w64 (apt install mingw-w64 g++-mingw-w64-x86-64-posix).', LLM_CONSEQUENCE)
    }
  }
  if (!haveCmake(what) || !haveLibclang(what)) return
  const compat = path.join(speechCrate, 'compat')
  const env = {
    CC_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-gcc-posix',
    CXX_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-g++-posix',
    CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: 'x86_64-w64-mingw32-gcc-posix',
    CMAKE_PROJECT_INCLUDE: path.join(compat, 'mingw_lib_prefix.cmake'),
    CFLAGS_x86_64_pc_windows_gnu: `-include ${path.join(compat, 'mingw_compat.h')}`,
    ...LLM_GGML_FLAGS
  }
  const failed = cargoLlm('windows', 'win', ['--target', WIN_TARGET], env)
  if (failed) return skip(what, `${failed}.`, undefined, LLM_CONSEQUENCE)
  const built = path.join(llmCrate, 'target', 'win', WIN_TARGET, 'release', 'ssw-llm.exe')
  const check = checkWindowsExe(built)
  if (!check.ok) return skip(what, `the build is not a usable x64 executable (${check.reason}).`, undefined, LLM_CONSEQUENCE)
  const bad = unexpectedLlmImports(readImports(readFileSync(built)))
  if (bad.length) return skip(what, `the build imports ${bad.join(', ')}; only ${LLM_IMPORTS.join(', ')} are allowed.`, 'Build against a llama-cpp-2 whose llama-cpp-sys-2 dependency has default-features = false (native/llm/README.md).', LLM_CONSEQUENCE)
  if (check.size > LLM_BUDGET.installed) return skip(what, `the build is ${check.size} bytes, over its ${LLM_BUDGET.installed} byte budget.`, undefined, LLM_CONSEQUENCE)
  copyOut(built, path.join(root, from))
  console.log(`build-native: ssw-llm.exe imports ${readImports(readFileSync(built)).join(', ')}`)
}

/** The text helper for this machine (the tests): native/bin/ssw-llm[.exe]. */
function buildLlmHost() {
  const what = 'the host text helper (native/bin/ssw-llm)'
  if (!haveCargo(what, LLM_CONSEQUENCE) || !haveCmake(what) || !haveLibclang(what)) return
  const failed = cargoLlm('host', 'host', [], {})
  if (failed) return skip(what, `${failed}.`, undefined, LLM_CONSEQUENCE)
  const exe = process.platform === 'win32' ? 'ssw-llm.exe' : 'ssw-llm'
  copyOut(path.join(llmCrate, 'target', 'host', 'release', exe), path.join(binDir, exe))
}

if (speechHostOnly) {
  buildSpeechHost()
} else if (llmHostOnly) {
  buildLlmHost()
} else if (llmOnly) {
  buildLlmWindows()
} else {
  buildCapture()
  buildSpeechWindows()
  buildLlmWindows()
}
if (problems.length) {
  console.error(`build-native: ${problems.length} helper(s) could not be built${required ? ' and --require / SSW_REQUIRE_NATIVE=1 is set' : ''}; failing.`)
  process.exit(1)
}
