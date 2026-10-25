// electron-builder configuration (JS so that signing and the native helper are picked up
// from the environment / disk). Build with `npm run dist:win`; see docs/BUILDING.md.
'use strict'

const { resolveWindowsSigning } = require('./scripts/lib/signing.cjs')
const { appFiles, nativeHelper, nativeHelperResource, nativeHelperStatus, SIGN_EXTS } = require('./scripts/lib/packaging.cjs')

const signing = resolveWindowsSigning(process.env, { projectDir: __dirname })
for (const w of signing.warnings) console.warn(`  • code signing: ${w}`)
if (signing.errors.length) throw new Error(`Code signing is misconfigured:\n- ${signing.errors.join('\n- ')}`)
console.log(`  • code signing: ${signing.summary}`)

const helper = nativeHelper()
const helperStatus = nativeHelperStatus()
if (helperStatus.bundle) console.log(`  • native capture helper: bundling ${helper.from} -> resources/${helper.to}`)
else if (helperStatus.present) console.warn(`  • native capture helper: NOT bundled, ${helper.from} is unusable (${helperStatus.reason})`)
else console.log('  • native capture helper: not built (the app falls back to Chromium capture)')

/**
 * The NSIS product GUID electron-builder derived from the app's first appId
 * (UUID v5 of 'com.samiulakhan12.screenstudio' in its namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3,
 * see app-builder-lib NsisTarget). Kept although the appId changed, so the Flown installer finds
 * the installed "Screen Studio for Windows" (registry Software\{GUID} and its Uninstall key),
 * runs its uninstaller (which removes the old shortcuts) and upgrades it in place instead of
 * installing a second app beside it. tests/packaging.test.ts recomputes it.
 */
const LEGACY_NSIS_GUID = '25fa5926-dc93-5490-a32e-c16bd99d39ca'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  // Windows AppUserModelID of the shortcuts: must match APP_USER_MODEL_ID in src/shared/brand.ts.
  appId: 'com.qbexel.flown',
  productName: 'Flown',
  executableName: 'Flown',
  copyright: 'Copyright © 2026 Qbexel',
  directories: { buildResources: 'build', output: 'dist' },
  // Only the build output, package.json and production node_modules ship (asar). This is the
  // single files list: a platform-level `files` would replace it instead of extending it.
  files: appFiles(),
  asarUnpack: ['node_modules/ffmpeg-static/ffmpeg.exe*', 'node_modules/uiohook-napi/**'],
  // Directory form on purpose: electron-builder copies a single-file `from` without its signing
  // transformer, so a file entry would ship the helper unsigned in signed builds.
  extraResources: helperStatus.bundle ? [nativeHelperResource()] : [],
  // The UI is English-only: Chromium's other 54 locale packs are ~50 MB of dead weight.
  electronLanguages: ['en-US'],
  compression: 'maximum',
  npmRebuild: false,
  // No auto-updater is wired up, so skip update metadata (app-update.yml, latest.yml, blockmap).
  publish: null,
  forceCodeSigning: signing.forceCodeSigning,
  // Flipped before signing. The signed exe never runs as plain Node (ELECTRON_RUN_AS_NODE), ignores
  // NODE_OPTIONS and --inspect, and loads only the app.asar whose header hash is embedded in it.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    artifactName: 'Flown-Setup-${version}.${ext}',
    // Every .exe is signed anyway; this adds the uiohook-napi .node in app.asar.unpacked.
    signExts: SIGN_EXTS,
    ...signing.win
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Flown',
    uninstallDisplayName: 'Flown',
    guid: LEGACY_NSIS_GUID,
    // Moves an upgraded "Screen Studio for Windows" folder to ...\Flown and removes leftover old shortcuts.
    include: 'build/installer.nsh',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    installerSidebar: 'build/installerSidebar.bmp',
    uninstallerSidebar: 'build/installerSidebar.bmp',
    differentialPackage: false
  }
}
