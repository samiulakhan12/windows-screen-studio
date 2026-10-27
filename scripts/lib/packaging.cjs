// What goes into the Windows package. Shared by electron-builder.config.cjs and the checks
// in scripts/predist.mjs and scripts/verify-dist.mjs so all three agree on the rules.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { checkWindowsExe } = require('./pe.cjs')

const ROOT = path.resolve(__dirname, '../..')

/**
 * The Windows ffmpeg.exe that ships: ffmpeg-static's ffmpeg-win32-x64 asset of this release
 * tag, gunzipped (https://github.com/eugeneware/ffmpeg-static/releases). The package signs it
 * with the publisher's certificate, so predist and verify-dist accept only this exact build.
 * sha256 is pe.cjs peContentHash, which is the same before and after signing. Update all three
 * values together when ffmpeg-static's binary-release-tag changes.
 */
const FFMPEG_EXE = {
  release: 'b6.1.1',
  size: 82797568,
  sha256: 'b146ee98b213af232337d8fa6574eeaee2d58b90e7832f338c06e7d9f1436f30'
}

/**
 * Extensions electron-builder signs besides .exe (its win.signExts): uiohook-napi's .node is a
 * DLL the main process loads, which Smart App Control or WDAC can block when it is unsigned.
 */
const SIGN_EXTS = ['.node']

/** Files of a packaged app folder that signing must cover (every .exe and SIGN_EXTS file), relative paths. */
function signedFiles(dir) {
  const out = []
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(p)
      else if (['.exe', ...SIGN_EXTS].includes(path.extname(entry.name).toLowerCase())) out.push(p)
    }
  }
  walk('')
  return out.sort()
}

/** Packages whose dependencies are needed only by their npm install script, never at runtime. */
const INSTALL_ONLY_DEPS_OF = ['ffmpeg-static']

/**
 * The native capture helper (scripts/build-native.mjs) as an electron-builder extraResources entry.
 * `to` is where src/main/nativeCapture.ts looks: process.resourcesPath/native/ssw-capture.exe.
 */
function nativeHelper() {
  return { from: 'native/bin/ssw-capture.exe', to: 'native/ssw-capture.exe' }
}

/** The extraResources entry that puts nativeHelper().from at resources/nativeHelper().to. */
function nativeHelperResource() {
  const { from, to } = nativeHelper()
  return { from: path.posix.dirname(from), to: path.posix.dirname(to), filter: [path.posix.basename(from)] }
}

/**
 * Whether the helper can be bundled: it must be a complete x64 Windows executable. A missing or
 * broken helper is never fatal (the app falls back to Chromium capture); it is just left out.
 * @returns {{ bundle: boolean, present: boolean, reason?: string, size?: number }}
 */
function nativeHelperStatus(rootDir = ROOT) {
  const file = path.join(rootDir, nativeHelper().from)
  if (!fs.existsSync(file)) return { bundle: false, present: false }
  const check = checkWindowsExe(file)
  return check.ok ? { bundle: true, present: true, size: check.size } : { bundle: false, present: true, reason: check.reason }
}

/**
 * The speech helpers (scripts/build-native.mjs, docs/design/offline-captions.md §2.4): the
 * standard build (AVX2 and friends) and the compatible one (any x64 processor). `to` is where
 * src/main/speech/helper.ts looks: process.resourcesPath/native/<file>.
 */
function speechHelpers() {
  return [
    { from: 'native/bin/ssw-speech.exe', to: 'native/ssw-speech.exe', build: 'standard' },
    { from: 'native/bin/ssw-speech-compat.exe', to: 'native/ssw-speech-compat.exe', build: 'compatible' }
  ]
}

/**
 * Whether each speech helper can be bundled, like nativeHelperStatus: a helper that is not a
 * complete x64 Windows executable is left out with a warning (captions then offer AI providers
 * only and the speech detector falls back to sound levels), never fatal.
 * @returns {{ from: string, to: string, build: string, bundle: boolean, present: boolean, reason?: string, size?: number }[]}
 */
function speechHelperStatus(rootDir = ROOT) {
  return speechHelpers().map((h) => {
    const file = path.join(rootDir, h.from)
    if (!fs.existsSync(file)) return { ...h, bundle: false, present: false }
    const check = checkWindowsExe(file)
    return check.ok ? { ...h, bundle: true, present: true, size: check.size } : { ...h, bundle: false, present: true, reason: check.reason }
  })
}

/**
 * The DLLs the speech helpers may import (§6.3): system DLLs only. bcryptprimitives
 * comes from Rust's HashMap seeding (ProcessPrng); peak memory uses K32GetProcessMemoryInfo
 * from kernel32, so psapi.dll never appears. Compared without case.
 */
const SPEECH_IMPORTS = ['KERNEL32.dll', 'ADVAPI32.dll', 'msvcrt.dll', 'ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll']

/** The imports of `names` that are not on SPEECH_IMPORTS. */
function unexpectedSpeechImports(names) {
  const allowed = SPEECH_IMPORTS.map((n) => n.toLowerCase())
  return names.filter((n) => !allowed.includes(n.toLowerCase()))
}

/**
 * The speech payload budget (§6.3): both helpers, the speech detector model, its MODEL.md and
 * the notices file, at most 3.5 MB brotli-compressed (quality 11, 16 MB window) and 10 MB installed.
 */
const SPEECH_BUDGET = { compressed: 3.5e6, installed: 10e6 }

/**
 * The extraResources entries of the speech feature, in directory form (so the signing
 * transformer applies to the helpers): the usable helpers next to the capture helper, and the
 * speech detector model with its MODEL.md.
 */
function speechResources(rootDir = ROOT) {
  const helpers = speechHelperStatus(rootDir).filter((h) => h.bundle)
  const out = []
  if (helpers.length) out.push({ from: 'native/bin', to: 'native', filter: helpers.map((h) => path.posix.basename(h.from)) })
  out.push({ from: 'resources/speech', to: 'speech', filter: ['ggml-silero-v6.2.0.bin', 'MODEL.md'] })
  return out
}

/**
 * The speech detector model that ships (resources/speech/, see MODEL.md): a copy of the pin in
 * src/shared/speech/catalog.ts VAD_MODEL, which tests/packaging.test.ts compares with it.
 */
const VAD_PIN = {
  file: 'ggml-silero-v6.2.0.bin',
  bytes: 885098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
}

/** Names THIRD_PARTY_NOTICES.txt must mention (§6.3), matched without case. */
const NOTICE_NAMES = ['whisper.cpp', 'ggml', 'Silero VAD', 'OpenAI Whisper', 'mingw-w64', 'FFmpeg', 'Electron', 'React', 'MediaPipe']

/** What is wrong with a notices text (empty: fine): at least 10 KB and every NOTICE_NAMES entry. */
function noticesProblems(text) {
  const out = []
  if (Buffer.byteLength(text) < 10 * 1024) out.push(`only ${Buffer.byteLength(text)} bytes (at least 10 KB expected)`)
  const lower = text.toLowerCase()
  const missing = NOTICE_NAMES.filter((n) => !lower.includes(n.toLowerCase()))
  if (missing.length) out.push(`does not name ${missing.join(', ')}`)
  return out
}

/** The third-party notices (scripts/notices.mjs), shown from About: resources/THIRD_PARTY_NOTICES.txt. */
function noticesResource() {
  return { from: 'resources', to: '.', filter: ['THIRD_PARTY_NOTICES.txt'] }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Node-style lookup of `name` from a package directory: its own node_modules, then each parent's. */
function resolvePackageDir(name, fromDir, rootDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.resolve(dir) === path.resolve(rootDir)) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = path.basename(parent) === 'node_modules' ? path.dirname(parent) : parent
  }
}

/** Directories of every package reachable from `names` through dependencies/optionalDependencies. */
function dependencyClosure(names, fromDir, rootDir) {
  const seen = new Set()
  const stack = names.map((name) => [name, fromDir])
  while (stack.length) {
    const [name, from] = stack.pop()
    const dir = resolvePackageDir(name, from, rootDir)
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const pkg = readJson(path.join(dir, 'package.json')) || {}
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) stack.push([dep, dir])
  }
  return seen
}

/** Package name of a package directory: the part after its last node_modules/ (keeps @scope/). */
function packageNameOf(dir) {
  const parts = dir.split(path.sep)
  return parts.slice(parts.lastIndexOf('node_modules') + 1).join('/')
}

/**
 * Names of the packages that only INSTALL_ONLY_DEPS_OF's install scripts use (ffmpeg-static
 * downloads its binary with them), wherever npm put them. Names, not paths: electron-builder
 * hoists nested node_modules to the top of app.asar, so they must be excluded there by name.
 * A name that a runtime dependency also uses is kept.
 */
function installOnlyPackages(rootDir = ROOT) {
  const pkg = readJson(path.join(rootDir, 'package.json')) || {}
  const installOnly = new Set()
  const needed = new Set()
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    const dir = resolvePackageDir(name, rootDir, rootDir)
    if (!dir) continue
    needed.add(name)
    const own = readJson(path.join(dir, 'package.json')) || {}
    const closure = dependencyClosure(Object.keys({ ...own.dependencies, ...own.optionalDependencies }), dir, rootDir)
    for (const d of closure) (INSTALL_ONLY_DEPS_OF.includes(name) ? installOnly : needed).add(packageNameOf(d))
  }
  return [...installOnly].filter((name) => !needed.has(name)).sort()
}

/** Packages the packaged app loads at runtime (what app.asar's node_modules should hold). */
function runtimePackages(rootDir = ROOT) {
  const pkg = readJson(path.join(rootDir, 'package.json')) || {}
  const roots = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
  const skip = new Set(installOnlyPackages(rootDir))
  const names = new Set([...dependencyClosure(roots, rootDir, rootDir)].map(packageNameOf))
  return [...names].filter((name) => !skip.has(name)).sort()
}

/** uiohook-napi ships prebuilt hooks for every OS; only win32-x64 runs in this package. */
function foreignPrebuilds(rootDir = ROOT) {
  const dir = path.join(rootDir, 'node_modules', 'uiohook-napi', 'prebuilds')
  try {
    return fs.readdirSync(dir).filter((d) => d !== 'win32-x64')
  } catch {
    return []
  }
}

/** The electron-builder `files` list: build output, package.json and a trimmed node_modules. */
function appFiles(rootDir = ROOT) {
  return [
    'out/**',
    '!out/**/*.map',
    'package.json',
    // electron-builder adds the production node_modules itself; these patterns trim them.
    '!node_modules/**/*.{md,markdown,map,ts,tsx,gyp,c,h,cc,cpp}',
    '!node_modules/**/{test,tests,example,examples,docs,.github}{,/**}',
    // ffmpeg-static: keep index.js, package.json and ffmpeg.exe (+ its LICENSE/README, required by the GPL).
    '!node_modules/ffmpeg-static/ffmpeg', // the build host's own binary when cross-building
    '!node_modules/ffmpeg-static/ffmpeg.{LICENSE,README}',
    '!node_modules/ffmpeg-static/{install.js,example.js,types}{,/**}',
    '!node_modules/ffmpeg-static/node_modules{,/**}',
    ...installOnlyPackages(rootDir).map((name) => `!node_modules/${name}{,/**}`),
    // uiohook-napi: the win32-x64 prebuild and its JS loader only.
    ...foreignPrebuilds(rootDir).map((d) => `!node_modules/uiohook-napi/prebuilds/${d}{,/**}`),
    '!node_modules/uiohook-napi/{libuiohook,src}{,/**}'
  ]
}

module.exports = {
  appFiles,
  FFMPEG_EXE,
  SIGN_EXTS,
  signedFiles,
  nativeHelper,
  nativeHelperResource,
  nativeHelperStatus,
  speechHelpers,
  speechHelperStatus,
  speechResources,
  noticesResource,
  noticesProblems,
  NOTICE_NAMES,
  VAD_PIN,
  SPEECH_IMPORTS,
  SPEECH_BUDGET,
  unexpectedSpeechImports,
  installOnlyPackages,
  runtimePackages,
  foreignPrebuilds,
  dependencyClosure,
  resolvePackageDir,
  ROOT
}
