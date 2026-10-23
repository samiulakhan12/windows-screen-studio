#!/usr/bin/env node
// Builds the native Windows capture helper (native/, Rust) and copies it to
// native/bin/ssw-capture.exe, where the app (development) and electron-builder
// (extraResources -> resources/native/ssw-capture.exe) pick it up.
//
//   node scripts/build-native.mjs            # warn and exit 0 when no Rust toolchain is usable
//   node scripts/build-native.mjs --require  # fail instead (release builds); also SSW_REQUIRE_NATIVE=1
//
// Windows builds for the host toolchain (x86_64-pc-windows-msvc, or -gnu); Linux and macOS
// cross-compile for x86_64-pc-windows-gnu, which needs `rustup target add x86_64-pc-windows-gnu`
// and the MinGW-w64 linker (x86_64-w64-mingw32-gcc). Without the helper the app records
// through Chromium (with the OS cursor in the video), so a missing toolchain is not fatal.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const crate = path.join(root, 'native')
const bin = path.join(crate, 'bin', 'ssw-capture.exe')
const required = process.argv.includes('--require') || process.env.SSW_REQUIRE_NATIVE === '1'

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts })
}

function skip(reason, hint) {
  const lines = [`build-native: ${reason}`]
  if (hint) lines.push(`build-native: ${hint}`)
  if (required) {
    console.error(lines.join('\n'))
    console.error('build-native: the capture helper is required (--require / SSW_REQUIRE_NATIVE=1); failing.')
    process.exit(1)
  }
  console.warn(lines.join('\n'))
  console.warn('build-native: WARNING: skipping ssw-capture.exe; the app will fall back to Chromium capture (cursor baked into the video).')
  process.exit(0)
}

const cargo = run('cargo', ['--version'])
if (cargo.error || cargo.status !== 0) {
  skip('no Rust toolchain found (cargo is not on PATH).', 'Install Rust from https://rustup.rs to build the native capture helper.')
}

const rustc = run('rustc', ['-vV'])
const host = /host: (\S+)/.exec(rustc.stdout ?? '')?.[1] ?? ''
let target
if (process.platform === 'win32') {
  target = host.endsWith('-gnu') ? 'x86_64-pc-windows-gnu' : 'x86_64-pc-windows-msvc'
} else {
  target = 'x86_64-pc-windows-gnu'
  const linker = run('x86_64-w64-mingw32-gcc', ['--version'])
  if (linker.error || linker.status !== 0) {
    skip('the MinGW-w64 linker (x86_64-w64-mingw32-gcc) is missing.', 'Install mingw-w64 (apt install mingw-w64 / brew install mingw-w64).')
  }
}

const rustup = run('rustup', ['target', 'list', '--installed'])
if (!rustup.error && rustup.status === 0 && !rustup.stdout.split(/\s+/).includes(target)) {
  skip(`the Rust target ${target} is not installed.`, `Run: rustup target add ${target}`)
}

console.log(`build-native: cargo build --release --target ${target}`)
const build = run('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')], {
  stdio: 'inherit'
})
if (build.error || build.status !== 0) {
  // A toolchain that is present but fails to build is a real problem, not a missing optional tool.
  console.error(`build-native: cargo build failed (${build.error?.message ?? `exit code ${build.status}`}).`)
  process.exit(1)
}

const built = path.join(crate, 'target', target, 'release', 'ssw-capture.exe')
if (!existsSync(built)) {
  console.error(`build-native: expected ${built} after the build, but it is missing.`)
  process.exit(1)
}
mkdirSync(path.dirname(bin), { recursive: true })
copyFileSync(built, bin)
console.log(`build-native: ${path.relative(root, bin)} (${Math.round(statSync(bin).size / 1024)} KB)`)
