#!/usr/bin/env node
// Checks what electron-builder produced (the last step of `npm run dist:win`), so a package that
// leaks the source tree, misses ffmpeg.exe, shows the stock Electron icon or carries the wrong
// name or publisher in its file properties is caught before it ships. Works on any OS: it reads the asar header and the PE resources directly.
//   node scripts/verify-dist.mjs [dist directory]      (default: dist)
// Exits 1 on a problem. Prints the install and installer sizes.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants as zlib } from 'node:zlib'

const require = createRequire(import.meta.url)
const { readAsarHeader, listAsar } = require('./lib/asar.cjs')
const { checkWindowsExe, parsePe, readIconGroups, readImports, readVersionStrings } = require('./lib/pe.cjs')
const { parseIco } = require('./lib/ico.cjs')
const { updateMetaProblems } = require('./lib/updateMeta.cjs')
const {
  FFMPEG_EXE,
  missingSpeechOptions,
  nativeHelper,
  nativeHelperStatus,
  noticesProblems,
  runtimePackages,
  signedFiles,
  SPEECH_BUDGET,
  SPEECH_HELPER_OPTIONS,
  SPEECH_IMPORTS,
  speechHelperStatus,
  staleSpeechHelper,
  unexpectedSpeechImports,
  VAD_PIN
} = require('./lib/packaging.cjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.resolve(root, process.argv[2] ?? 'dist')
const unpacked = path.join(distDir, 'win-unpacked')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const failures = []
const ok = (msg) => console.log(`verify-dist: ok   ${msg}`)
const note = (msg) => console.log(`verify-dist: note ${msg}`)
const fail = (msg) => {
  console.error(`verify-dist: FAIL ${msg}`)
  failures.push(msg)
}
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB` // decimal MB, as in docs/BUILDING.md

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}

if (!existsSync(unpacked)) {
  console.error(`verify-dist: ${path.relative(root, unpacked)} does not exist. Run npm run dist:win first.`)
  process.exit(1)
}

// 1. app.asar holds only the build output, package.json and the runtime node_modules (F32).
const asarFile = path.join(unpacked, 'resources', 'app.asar')
const entries = listAsar(readAsarHeader(asarFile))
const top = [...new Set(entries.map((e) => e.path.split('/')[1]))].sort()
const strayTop = top.filter((name) => !['out', 'package.json', 'node_modules'].includes(name))
if (strayTop.length) fail(`app.asar contains files that must not ship: /${strayTop.join(', /')}`)
else ok(`app.asar top level: /${top.join(', /')}`)
const maps = entries.filter((e) => !e.dir && e.path.endsWith('.map'))
if (maps.length) fail(`app.asar contains ${maps.length} source map(s), e.g. ${maps[0].path}`)

// Every package in the archive, nested ones included (electron-builder normally hoists them).
const packagesInAsar = new Set()
for (const e of entries) {
  const parts = e.path.split('/')
  for (let i = parts.indexOf('node_modules'); i !== -1 && i < parts.length - 1; i = parts.indexOf('node_modules', i + 1)) {
    const scope = parts[i + 1]
    if (!scope.startsWith('@')) packagesInAsar.add(scope)
    else if (parts[i + 2]) packagesInAsar.add(`${scope}/${parts[i + 2]}`)
  }
}
const expected = runtimePackages()
const unexpected = [...packagesInAsar].filter((name) => !expected.includes(name)).sort()
const missing = expected.filter((name) => !packagesInAsar.has(name))
if (unexpected.length) fail(`app.asar ships packages that are not runtime dependencies: ${unexpected.join(', ')}`)
if (missing.length) fail(`app.asar lacks runtime packages: ${missing.join(', ')}`)
if (!unexpected.length && !missing.length) ok(`app.asar node_modules: ${[...packagesInAsar].sort().join(', ')}`)

// The camera's background blur runs fully offline: its worker, the WebAssembly runtime and the
// person model are bundled by Vite into out/renderer/assets and must all be in the archive.
const assetFiles = entries.filter((e) => !e.dir && e.path.startsWith('/out/renderer/assets/')).map((e) => ({ name: e.path.split('/').pop(), size: e.size ?? 0 }))
const SEGMENTATION_FILES = [
  { label: 'segmentation worker', re: /^segmentation\.worker-[\w-]+\.js$/, min: 50e3 },
  { label: 'MediaPipe WebAssembly loader', re: /^vision_wasm_module_internal-[\w-]+\.js$/, min: 100e3 },
  { label: 'MediaPipe WebAssembly runtime', re: /^vision_wasm_module_internal-[\w-]+\.wasm$/, min: 5e6 },
  { label: 'person segmentation model', re: /^selfie_segmenter-[\w-]+\.tflite$/, min: 100e3 }
]
const segmentationMissing = SEGMENTATION_FILES.filter((f) => !assetFiles.some((a) => f.re.test(a.name) && a.size >= f.min))
if (segmentationMissing.length) fail(`app.asar lacks the background blur files: ${segmentationMissing.map((f) => f.label).join(', ')}`)
else ok(`background blur: worker, WebAssembly runtime and model in out/renderer/assets (${mb(assetFiles.filter((a) => SEGMENTATION_FILES.some((f) => f.re.test(a.name))).reduce((t, a) => t + a.size, 0))})`)
// The unwanted-sound finder (docs/design/sound-finder.md) is bundled the same way.
const SOUND_FILES = [
  { label: 'sound finder worker', re: /^sounds\.worker-[\w-]+\.js$/, min: 30e3 },
  { label: 'MediaPipe audio WebAssembly loader', re: /^audio_wasm_module_internal-[\w-]+\.js$/, min: 100e3 },
  { label: 'MediaPipe audio WebAssembly runtime', re: /^audio_wasm_module_internal-[\w-]+\.wasm$/, min: 4e6 },
  { label: 'YAMNet sound model', re: /^yamnet-[\w-]+\.tflite$/, min: 4e6 }
]
const soundMissing = SOUND_FILES.filter((f) => !assetFiles.some((a) => f.re.test(a.name) && a.size >= f.min))
if (soundMissing.length) fail(`app.asar lacks the sound finder files: ${soundMissing.map((f) => f.label).join(', ')}`)
else ok(`sound finder: worker, WebAssembly runtime and model in out/renderer/assets (${mb(assetFiles.filter((a) => SOUND_FILES.some((f) => f.re.test(a.name))).reduce((t, a) => t + a.size, 0))})`)

// 2. ffmpeg.exe is the pinned Windows x64 build, unpacked next to the archive (F43).
const ffmpegDir = path.join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static')
const ffmpeg = checkWindowsExe(path.join(ffmpegDir, 'ffmpeg.exe'), { minBytes: 20 * 1048576, pin: FFMPEG_EXE })
if (!ffmpeg.ok) fail(`resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe: ${ffmpeg.reason}`)
else ok(`ffmpeg.exe x64, ${mb(ffmpeg.size)}, SHA-256 matches the ${FFMPEG_EXE.release} pin`)
if (!existsSync(path.join(ffmpegDir, 'ffmpeg.exe.LICENSE'))) fail('ffmpeg.exe.LICENSE is missing (the GPL requires it next to ffmpeg.exe)')
if (existsSync(path.join(ffmpegDir, 'ffmpeg'))) fail('the build host ffmpeg binary (node_modules/ffmpeg-static/ffmpeg) was packaged')

// 3. Only Windows x64 native code and the en-US locale.
const prebuilds = path.join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'uiohook-napi', 'prebuilds')
if (existsSync(prebuilds)) {
  const dirs = readdirSync(prebuilds)
  if (dirs.join() !== 'win32-x64') fail(`uiohook-napi prebuilds for other platforms were packaged: ${dirs.join(', ')}`)
  else ok('uiohook-napi: win32-x64 prebuild only')
} else {
  note('uiohook-napi is not packaged (optional dependency): click detection will be unavailable')
}
const locales = readdirSync(path.join(unpacked, 'locales'))
if (locales.join() !== 'en-US.pak') fail(`unexpected Chromium locales: ${locales.join(', ')}`)
else ok('locales: en-US.pak only')

// 4. Native capture helper (optional; bundled when native/bin holds a usable build).
const helper = nativeHelperStatus()
const helperOut = path.join(unpacked, 'resources', nativeHelper().to)
if (existsSync(helperOut)) {
  const check = checkWindowsExe(helperOut)
  if (!check.ok) fail(`resources/${nativeHelper().to}: ${check.reason}`)
  else ok(`native capture helper: resources/${nativeHelper().to} (${Math.round(check.size / 1024)} KB)`)
} else if (helper.bundle) {
  fail(`${nativeHelper().from} is usable but resources/${nativeHelper().to} was not packaged`)
} else {
  note(`native capture helper not bundled${helper.present ? ` (${nativeHelper().from}: ${helper.reason})` : ''}: recordings use Chromium capture (OS cursor in the video)`)
}

// 4b. Speech: the two helpers (x64, system DLLs only), the speech detector model (its pin), the
// notices, and the speech payload's budget (docs/design/offline-captions.md §6.3).
const resources = path.join(unpacked, 'resources')
const payload = []
for (const h of speechHelperStatus()) {
  const out = path.join(resources, h.to)
  if (!existsSync(out)) {
    if (h.bundle) fail(`${h.from} is usable but resources/${h.to} was not packaged`)
    else if (process.env.SSW_REQUIRE_NATIVE === '1') fail(`the speech helper resources/${h.to} is missing and SSW_REQUIRE_NATIVE=1 (${h.present ? h.reason : 'not built'})`)
    else note(`speech helper resources/${h.to} not bundled${h.present ? ` (${h.from}: ${h.reason})` : ''}: captions on this PC unavailable, the speech detector falls back to sound levels`)
    continue
  }
  const check = checkWindowsExe(out)
  if (!check.ok) {
    fail(`resources/${h.to}: ${check.reason}`)
    continue
  }
  const exe = readFileSync(out)
  const imports = readImports(exe)
  const bad = unexpectedSpeechImports(imports)
  const stale = missingSpeechOptions(exe)
  if (bad.length) fail(`resources/${h.to} imports ${bad.join(', ')}; only ${SPEECH_IMPORTS.join(', ')} are allowed`)
  else if (stale.length) fail(staleSpeechHelper(`resources/${h.to}`, stale))
  else ok(`speech helper (${h.build}): resources/${h.to} (${Math.round(check.size / 1024)} KB), imports ${imports.join(', ')}, knows ${SPEECH_HELPER_OPTIONS.join(' ')}`)
  payload.push(out)
}
const vadFile = path.join(resources, 'speech', VAD_PIN.file)
if (!existsSync(vadFile)) fail(`resources/speech/${VAD_PIN.file} is missing`)
else {
  const buf = readFileSync(vadFile)
  const hash = createHash('sha256').update(buf).digest('hex')
  if (buf.length !== VAD_PIN.bytes || hash !== VAD_PIN.sha256) fail(`resources/speech/${VAD_PIN.file} is not the pinned model (${buf.length} bytes, SHA-256 ${hash})`)
  else ok(`speech detector model: resources/speech/${VAD_PIN.file}, SHA-256 matches the pin`)
  payload.push(vadFile)
}
const modelMd = path.join(resources, 'speech', 'MODEL.md')
if (!existsSync(modelMd)) fail('resources/speech/MODEL.md is missing')
else payload.push(modelMd)
const noticesFile = path.join(resources, 'THIRD_PARTY_NOTICES.txt')
if (!existsSync(noticesFile)) fail('resources/THIRD_PARTY_NOTICES.txt is missing')
else {
  const problems = noticesProblems(readFileSync(noticesFile, 'utf8'))
  if (problems.length) fail(`resources/THIRD_PARTY_NOTICES.txt ${problems.join('; ')}`)
  else ok(`third-party notices: resources/THIRD_PARTY_NOTICES.txt (${mb(statSync(noticesFile).size)})`)
  payload.push(noticesFile)
}
{
  // Compressed the way an installer would: one solid stream, brotli quality 11 with a 16 MB window.
  const brotli = (buf) => brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_LGWIN]: 24, [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length
  const files = payload.map((f) => ({ name: path.relative(resources, f).split(path.sep).join('/'), buf: readFileSync(f) }))
  for (const f of files) note(`speech payload: ${f.name} ${f.buf.length} B raw, ${brotli(f.buf)} B brotli`)
  const raw = files.reduce((t, f) => t + f.buf.length, 0)
  const packed = brotli(Buffer.concat(files.map((f) => f.buf)))
  const line = `speech payload: ${files.length} files, ${raw} B installed (budget ${SPEECH_BUDGET.installed} B), ${packed} B brotli-compressed (budget ${SPEECH_BUDGET.compressed} B)`
  if (raw > SPEECH_BUDGET.installed || packed > SPEECH_BUDGET.compressed) fail(line)
  else ok(line)
}

// 5. Our icon is embedded in the app exe and the installer (F33).
const icoImages = parseIco(readFileSync(path.join(root, 'build', 'icon.ico')))
const icoSizes = icoImages.map((i) => i.width).sort((a, b) => a - b)
// Every size Explorer, the taskbar and the title bar ask for at 100-200 % scaling.
const REQUIRED_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]
const missingSizes = REQUIRED_ICON_SIZES.filter((s) => !icoSizes.includes(s))
if (missingSizes.length) fail(`build/icon.ico lacks the ${missingSizes.join(', ')} px images (npm run icons)`)
function checkIcon(label, file) {
  const buf = readFileSync(file)
  const group = readIconGroups(buf)[0]
  if (!group) return fail(`${label} has no icon resource`)
  const sizes = group.images.map((i) => i.width).sort((a, b) => a - b)
  const big = group.images.find((i) => i.width === 256)?.data
  const ours = icoImages.find((i) => i.width === 256)?.data
  if (sizes.join() !== icoSizes.join() || !big || !ours || !Buffer.from(big).equals(Buffer.from(ours))) {
    return fail(`${label} does not carry build/icon.ico (icon sizes ${sizes.join(', ')})`)
  }
  ok(`${label} icon = build/icon.ico (${sizes.join(', ')} px)`)
}
const appExe = path.join(unpacked, `${pkg.productName}.exe`)
checkIcon(path.basename(appExe), appExe)

const installer = path.join(distDir, `${pkg.productName}-Setup-${pkg.version}.exe`)
let installerSize = 0
if (existsSync(installer)) {
  installerSize = statSync(installer).size
  checkIcon(path.basename(installer), installer)
} else {
  fail(`${path.relative(root, installer)} is missing`)
}

// 5b. File properties (Explorer's Details tab, the UAC prompt, Task Manager): the product and
// its publisher, from package.json (productName, author) and the builder's copyright.
const company = typeof pkg.author === 'object' ? pkg.author.name : pkg.author
function checkVersionStrings(label, file, expected) {
  const strings = readVersionStrings(readFileSync(file))
  const wrong = Object.entries(expected).filter(([key, want]) => (want instanceof RegExp ? !want.test(strings[key] ?? '') : strings[key] !== want))
  if (wrong.length) return fail(`${label} file properties: ${wrong.map(([key, want]) => `${key} is ${JSON.stringify(strings[key] ?? null)}, expected ${want}`).join('; ')}`)
  ok(`${label} properties: ${Object.keys(expected).map((key) => `${key} "${strings[key]}"`).join(', ')}`)
}
const copyright = new RegExp(`^Copyright © \\d{4} ${company}$`)
checkVersionStrings(path.basename(appExe), appExe, { CompanyName: company, ProductName: pkg.productName, FileDescription: pkg.productName, LegalCopyright: copyright })
if (existsSync(installer)) checkVersionStrings(path.basename(installer), installer, { CompanyName: company, ProductName: pkg.productName, LegalCopyright: copyright })

// 6. Signing status (informational unless SSW_REQUIRE_SIGNING=1): the installer and every .exe
// and .node in the app folder (app exe, ffmpeg.exe, the native helper, elevate.exe, uiohook-napi).
const signed = (file) => {
  try {
    return parsePe(readFileSync(file)).signed
  } catch {
    return false
  }
}
const unsignedFiles = signedFiles(unpacked).filter((rel) => !signed(path.join(unpacked, rel)))
if (!signed(installer)) unsignedFiles.push(path.relative(distDir, installer))
const signState = unsignedFiles.length ? `UNSIGNED: ${unsignedFiles.join(', ')}` : `installer and ${signedFiles(unpacked).length} file(s) in win-unpacked signed`
if (process.env.SSW_REQUIRE_SIGNING === '1' && unsignedFiles.length) fail(`code signing required but ${signState}`)
else note(`Authenticode: ${signState}`)

// 7. Update metadata (docs/design/auto-update.md): the app knows where to look for updates, and
// latest.yml (uploaded with the installer) names this installer with its real SHA-512 and size.
{
  const builder = require(path.join(root, 'electron-builder.config.cjs'))
  const publish = Array.isArray(builder.publish) ? builder.publish[0] : builder.publish
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
  const installerName = path.basename(installer)
  const problems = publish
    ? updateMetaProblems({
        appUpdateText: read(path.join(unpacked, 'resources', 'app-update.yml')),
        latestText: read(path.join(distDir, 'latest.yml')),
        publish,
        version: pkg.version,
        installerName,
        installerSha512: existsSync(installer) ? createHash('sha512').update(readFileSync(installer)).digest('base64') : '',
        installerSize
      })
    : ['electron-builder.config.cjs has no publish target (the app could not update itself)']
  for (const p of problems) fail(`update metadata: ${p}`)
  if (!problems.length) ok(`update metadata: app-update.yml -> ${publish.provider} ${publish.owner}/${publish.repo}; latest.yml ${pkg.version} -> ${installerName} (sha512 matches)`)
}

const installSize = dirSize(unpacked)
console.log(
  `verify-dist: sizes: installer ${mb(installerSize)}, installed ${mb(installSize)} ` +
    `(app.asar ${mb(statSync(asarFile).size)}, app.asar.unpacked ${mb(dirSize(path.join(unpacked, 'resources', 'app.asar.unpacked')))})`
)
if (failures.length) {
  console.error(`\nverify-dist: ${failures.length} problem(s); do not ship this build.`)
  process.exit(1)
}
console.log('verify-dist: all checks passed.')
