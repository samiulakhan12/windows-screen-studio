#!/usr/bin/env node
// Checks what electron-builder produced (the last step of `npm run dist:win`), so a package that
// leaks the source tree, misses ffmpeg.exe or shows the stock Electron icon is caught before it
// ships. Works on any OS: it reads the asar header and the PE resources directly.
//   node scripts/verify-dist.mjs [dist directory]      (default: dist)
// Exits 1 on a problem. Prints the install and installer sizes.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { readAsarHeader, listAsar } = require('./lib/asar.cjs')
const { checkWindowsExe, parsePe, readIconGroups } = require('./lib/pe.cjs')
const { parseIco } = require('./lib/ico.cjs')
const { FFMPEG_EXE, nativeHelper, nativeHelperStatus, runtimePackages, signedFiles } = require('./lib/packaging.cjs')

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

// 5. Our icon is embedded in the app exe and the installer (F33).
const icoImages = parseIco(readFileSync(path.join(root, 'build', 'icon.ico')))
const icoSizes = icoImages.map((i) => i.width).sort((a, b) => a - b)
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

const installer = path.join(distDir, `ScreenStudio-Setup-${pkg.version}.exe`)
let installerSize = 0
if (existsSync(installer)) {
  installerSize = statSync(installer).size
  checkIcon(path.basename(installer), installer)
} else {
  fail(`${path.relative(root, installer)} is missing`)
}

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
