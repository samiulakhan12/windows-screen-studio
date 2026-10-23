#!/usr/bin/env node
// Pre-flight for `npm run dist:win`. Everything the Windows package needs is checked BEFORE
// electron-builder runs, so a broken installer is never produced silently:
//   1. ffmpeg.exe: ffmpeg-static downloads only the build host's binary, so on Linux/macOS the
//      Windows one is fetched here (and a corrupt or wrong-architecture file is replaced).
//   2. The native capture helper is built with scripts/build-native.mjs when that script exists.
//      It is optional (the app falls back to Chromium capture) unless SSW_REQUIRE_NATIVE=1.
//   3. The icon files exist (npm run icons).
//   4. The code-signing environment is consistent (unsigned builds are fine).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { checkWindowsExe } = require('./lib/pe.cjs')
const { parseIco } = require('./lib/ico.cjs')
const { loadBuilderEnv, resolveWindowsSigning } = require('./lib/signing.cjs')
const { nativeHelper } = require('./lib/packaging.cjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []
const log = (msg) => console.log(`predist: ${msg}`)
const warn = (msg) => {
  console.warn(`predist: WARNING: ${msg}`)
  notes.push(msg)
}
const fail = (msg) => {
  console.error(`predist: ERROR: ${msg}`)
  failures.push(msg)
}

// 1. ffmpeg.exe ---------------------------------------------------------------------------
function ensureFfmpeg() {
  const dir = path.join(root, 'node_modules', 'ffmpeg-static')
  const exe = path.join(dir, 'ffmpeg.exe')
  if (!existsSync(path.join(dir, 'package.json'))) {
    fail('node_modules/ffmpeg-static is missing. Run npm install first.')
    return
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const release = pkg['ffmpeg-static']?.['binary-release-tag'] ?? 'unknown'
  const min = 20 * 1024 * 1024 // the gyan.dev essentials build is ~80 MB
  let check = checkWindowsExe(exe, { minBytes: min })
  if (!check.ok) {
    if (check.reason !== 'missing') {
      warn(`node_modules/ffmpeg-static/ffmpeg.exe is unusable (${check.reason}); downloading it again.`)
      rmSync(exe, { force: true })
    } else {
      log(`fetching the Windows ffmpeg.exe (ffmpeg-static ${pkg.version}, release ${release})...`)
    }
    // ffmpeg-static's own installer, pointed at Windows x64. FFMPEG_BIN would redirect it elsewhere.
    const env = { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' }
    delete env.FFMPEG_BIN
    const r = spawnSync(process.execPath, ['install.js'], { cwd: dir, env, stdio: 'inherit' })
    check = checkWindowsExe(exe, { minBytes: min })
    if (r.status !== 0 || !check.ok) {
      rmSync(exe, { force: true })
      fail(
        `could not get the Windows ffmpeg.exe (${r.error?.message ?? (r.status !== 0 ? `ffmpeg-static's install.js exited with code ${r.status}` : check.reason)}).\n` +
          `  Without it every recording would fail on Windows. Check your network/proxy and run npm run dist:win again,\n` +
          `  or download ffmpeg-win32-x64.gz from https://github.com/eugeneware/ffmpeg-static/releases/tag/${release},\n` +
          `  gunzip it to node_modules/ffmpeg-static/ffmpeg.exe (FFMPEG_BINARIES_URL can point install.js at a mirror).`
      )
      return
    }
  }
  const readme = path.join(dir, 'ffmpeg.exe.README')
  const version = existsSync(readme) ? /^Version:\s*(\S+)/m.exec(readFileSync(readme, 'utf8'))?.[1] : null
  if (!existsSync(path.join(dir, 'ffmpeg.exe.LICENSE'))) warn('ffmpeg.exe.LICENSE is missing; the GPL requires shipping it with ffmpeg.exe.')
  log(`ffmpeg.exe OK (${(check.size / 1048576).toFixed(1)} MB, x64${version ? `, ${version}` : ''})`)
}

// 2. Native capture helper ------------------------------------------------------------------
function buildNativeHelper() {
  const script = path.join(root, 'scripts', 'build-native.mjs')
  const required = process.env.SSW_REQUIRE_NATIVE === '1'
  const bin = path.join(root, nativeHelper().from)
  const before = existsSync(bin) ? statSync(bin).mtimeMs : null
  if (existsSync(script)) {
    const r = spawnSync(process.execPath, [script, ...(required ? ['--require'] : [])], { cwd: root, stdio: 'inherit' })
    if (r.status !== 0) {
      if (required) {
        fail('the native capture helper is required (SSW_REQUIRE_NATIVE=1) but could not be built.')
        return
      }
      warn(`scripts/build-native.mjs failed (${r.error?.message ?? `exit code ${r.status}`}).`)
    }
  } else if (required) {
    fail('SSW_REQUIRE_NATIVE=1 but scripts/build-native.mjs does not exist.')
    return
  } else {
    log('scripts/build-native.mjs does not exist; not building the native capture helper.')
  }
  if (!existsSync(bin)) {
    const msg = 'the native capture helper is not bundled: Windows recordings use Chromium capture, with the OS cursor in the video.'
    if (required) fail(msg)
    else warn(msg)
    return
  }
  const check = checkWindowsExe(bin)
  if (!check.ok) {
    const msg = `${nativeHelper().from} is not a usable x64 Windows executable (${check.reason}), so it is left out of the package. Rebuild it (npm run build:native) or delete it.`
    if (required) fail(msg)
    else warn(msg)
    return
  }
  const after = statSync(bin).mtimeMs
  if (before !== null && after === before && existsSync(script)) {
    warn(`bundling the previously built ${nativeHelper().from} from ${new Date(after).toISOString()}; it was not rebuilt now.`)
  }
  log(`native helper OK (${nativeHelper().from}, ${Math.round(check.size / 1024)} KB) -> resources/${nativeHelper().to}`)
}

// 3. Icons --------------------------------------------------------------------------------
function checkIcons() {
  const ico = path.join(root, 'build', 'icon.ico')
  try {
    const sizes = parseIco(readFileSync(ico)).map((e) => e.width)
    if (!sizes.includes(256) || !sizes.includes(16)) throw new Error(`sizes ${sizes.join(', ')} lack 16 or 256`)
    log(`icon OK (build/icon.ico: ${sizes.join(', ')} px)`)
  } catch (err) {
    fail(`build/icon.ico is unusable (${err.code === 'ENOENT' ? 'missing' : err.message}). Regenerate it with npm run icons.`)
  }
  if (!existsSync(path.join(root, 'build', 'installerSidebar.bmp'))) fail('build/installerSidebar.bmp is missing. Regenerate it with npm run icons.')
}

// 4. Code signing ---------------------------------------------------------------------------
function checkSigning() {
  const added = loadBuilderEnv(root)
  if (added.length) log(`read ${added.join(', ')} from electron-builder.env`)
  const signing = resolveWindowsSigning(process.env, { projectDir: root })
  for (const w of signing.warnings) warn(`code signing: ${w}`)
  for (const e of signing.errors) fail(`code signing: ${e}`)
  if (!signing.errors.length) log(`code signing: ${signing.summary}`)
}

ensureFfmpeg()
buildNativeHelper()
checkIcons()
checkSigning()
if (failures.length) {
  console.error(`\npredist: ${failures.length} problem(s) must be fixed before packaging (see above).`)
  process.exit(1)
}
log(notes.length ? `ready, with ${notes.length} warning(s) above.` : 'ready.')
