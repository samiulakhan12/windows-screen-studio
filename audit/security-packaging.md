# Security and packaging audit

Scope: every `ipcMain.handle`/`ipcMain.on` in `src/main/*`, the preload bridge, `studio-media://`,
project file operations, window options and navigation, the renderer CSP, packaging scripts and
config, dependencies, child processes and the native helper's command interface.

Audited at commit `b25a136`. No source file was changed.

## How the findings were checked

- `npm ci` and the Electron 44.9.3 binary download both worked. `npm run build` passed, and
  `npx vitest run` passed (75 files, 1066 tests).
- **Real app probe.** F1, F2 and F3 were reproduced in the built app under Xvfb with Playwright
  (`_electron.launch`, same setup as `tests/e2e/helpers.cjs`). The probe called the real
  `window.api` IPC against a temporary `HOME` holding the project folders described below. The
  script is not committed; its output is quoted with each finding.
- `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities.
- The packaging findings come from reading `electron-builder.config.cjs`, `scripts/*` and
  electron-builder 26.15.3's `app-builder-lib/out/winPackager.js`. No Windows package was built.

## Findings (most severe first)

### F1 (high): "Recover" on a copied unfinished-recording folder deletes a different, finished project

- **Where:** `src/main/recordingIpc.ts:740-744` (`recover`), `src/main/recordingIpc.ts:653-673`
  (`runProcessing`), `src/main/recording/finalize.ts:138-146`, `src/main/projects.ts:175-181`
  (`readManifest`).
- **Problem:** Home lists unfinished recordings by **folder name**, and `recordings:recover` gets
  that name. `recover()` then reads `recording.json` and passes the manifest to `runProcessing`,
  which works only with `manifest.id`, the id **stored in the file**. Nothing checks that
  `manifest.id` matches the folder:
  - `writeManifest(m)` writes into `projectDir(m.id)`;
  - `processRecording` reads the raw files from `projectDir(m.id)`;
  - on `EmptyRecordingError`, `runProcessing` calls `projects.deleteProject(m.id)`, which deletes
    that folder recursively.
- **Failure scenario:**
  1. The user copies an unfinished recording folder `rec-A` as a backup, under any name that
     matches `ID_RE`. OneDrive's conflict copies (`rec-A-<PCNAME>`) also match, and `Videos` is
     often OneDrive-backed.
  2. The user recovers `rec-A`. It becomes a finished project, and its raw `screen.webm` is
     deleted.
  3. The user later clicks **Recover** on the backup. `processRecording` looks for `screen.webm`
     in `rec-A`, finds nothing, and throws "Nothing was captured". `runProcessing` then deletes the
     **finished, edited project `rec-A`**. The backup itself is left untouched.

  If `rec-A` is still unfinished, recovering the backup instead processes `rec-A`'s files, and the
  backup is never used. Also, `processing.has(id)` checks the folder name, not `m.id`, so two
  recoveries of the same `m.id` can run at once.
- **Evidence (real app probe):** `rec-B` was a finished project (`project.json`, `screen.mp4`).
  `rec-B-backup` held `recording.json` with `id: "rec-B"` and a non-empty `screen.webm`.
  ```
  unfinished: ["rec-B-backup"]
  recover rec-B-backup -> err ... Nothing was captured: the recording contains no video.
  rec-B exists false   rec-B-backup files [ 'recording.json', 'screen.webm' ]
  ```
- **Fix:** make the folder name the only source of the id when reading a manifest.
  ```ts
  // projects.ts readManifest(id)
  const m = JSON.parse(await fs.readFile(...)) as RecordingManifest
  return { ...m, id }          // the folder decides; a copied manifest never points elsewhere
  ```
  Also, in `runProcessing`, delete on `EmptyRecordingError` only when the folder holds no raw file
  at all (`rawBytes(dir) === 0`).

### F2 (medium): Home lists a copied project under the original's id, so deleting the copy deletes the original

- **Where:** `src/main/projects.ts:93-108` (`listProjects` returns `p.id` and
  `projectDir(p.id)`); used by `src/renderer/src/views/Home.tsx:649` (`deleteProject(p.id)`) and
  by load and save (`projectsIpc.ts:52-69`, `saveProjectNow` writes to `projectDir(project.id)`).
- **Problem:** `listProjects` reads every folder that matches `ID_RE`. It then reports the id
  from inside `project.json`, not the folder name. A copied project folder therefore appears as a
  second entry with the **original's** id and folder.
- **Failure scenario:** with folders `rec-A` and `rec-A-PC1` (a copy, for example a OneDrive
  conflict copy), Home shows two cards, both with id `rec-A`.
  - Opening either card opens and edits `rec-A`.
  - Deleting the card the user believes is the duplicate deletes `rec-A`, the original. The copy
    stays, still showing id `rec-A`, which now points to a deleted folder.
- **Evidence (real app probe):**
  ```
  list: [["rec-A","original A",".../rec-A"],["rec-A","copy of A",".../rec-A"]]
  deleteProject('rec-A') -> rec-A exists false, rec-A-PC1 exists true
  ```
- **Fix:** in `readProject(id)`, override the stored id with the folder name:
  `return { ...migrateProject(...), id }`. That one change fixes listing, loading, saving
  (the editor saves `project.id`) and deleting. `listProjects` can then use `e.name` for `dir`.

### F3 (medium): Navigation is not restricted, so a dropped or navigated-to local page gets the full `window.api` and silent camera, microphone and screen capture

- **Where:**
  - `src/main/windows.ts:35-66`, `src/main/recording/toolbarWindow.ts:14-26` and
    `src/main/recording/regionWindow.ts:22-38`: no `will-navigate` or `will-redirect` handler
    anywhere. Toolbar and region windows also have no `setWindowOpenHandler`.
  - `src/main/recordingIpc.ts:428-430`: the permission handler grants `media` and
    `display-capture` to **any** requesting page.
  - No renderer code calls `preventDefault` on `dragover` or `drop` (grep of `src/renderer/src`).
  - No IPC handler checks `event.senderFrame`.
- **Problem:** any top-level navigation of the main window keeps the preload, so the new page gets
  `window.api` (56 methods). These include `deleteProject`, `saveProject`/`saveProjectSync`
  (overwrite any project's `project.json`), `setPref`, `updateRecordingSettings`, `getSources` and
  `prepareCapture`. The permission handler also lets that page call `getUserMedia` for camera and
  microphone without a prompt. Chromium's default action for a file dropped on a window that does
  not cancel the drop is to navigate to it.
- **Failure scenario:** the user drags an `.html` file (a downloaded page, a mail attachment) onto
  the app window, or a future bug navigates the window. The page's script can then:
  - delete or overwrite every project;
  - change the recording hotkeys;
  - record the camera and microphone without any prompt.

  Dropping an image or video by mistake does no harm of that kind, but it replaces the editor:
  any running export is aborted (`exportIpc.ts:120`), and edits not yet autosaved are lost.
- **Evidence (real app probe):** the main window was navigated to a local file:
  `location.href = 'file://.../evil.html'`.
  ```
  after navigation url file:///tmp/sswhome-.../evil.html   title api:object:56
  evil page can list projects: [ 'rec-D', 'rec-A', 'rec-C' ]
  ```
  An OS-level file drop could not be reproduced under Xvfb. CDP's
  `Input.dispatchDragEvent` does not trigger Chromium's drop navigation, so that path is from
  Chromium's documented default.
- **Fix:** one guard in `src/main/index.ts` covers all windows:
  ```ts
  const isAppUrl = (u: string): boolean => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!app.isPackaged && dev) return u.startsWith(dev)
    return u.split('#')[0] === pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
  }
  app.on('web-contents-created', (_e, wc) => {
    const block = (e: Electron.Event, url: string): void => { if (!isAppUrl(url)) e.preventDefault() }
    wc.on('will-navigate', block)
    wc.on('will-redirect', block)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))  // windows.ts re-sets its https -> openExternal handler for the main window
  })
  ```
  In-app routing only changes the hash, which does not fire `will-navigate`. Also:
  - make the permission handler check
    `details.requestingUrl`/`wc.getURL()` with `isAppUrl`;
  - add `document.addEventListener('dragover'|'drop', e => e.preventDefault())` in the renderer.

### F4 (medium): Signed release builds ship the unsigned `uiohook-napi.node`, and `verify-dist` checks only 2 of the signed files

- **Where:** `electron-builder.config.cjs:38-43` (no `signExts`); `scripts/verify-dist.mjs:133-137`.
- **Problem:** electron-builder 26 signs only `*.exe` unless `signExts` is set. In
  `app-builder-lib/out/winPackager.js:203-218`, `shouldSignFile` returns `isExe` when `signExts`
  is empty, and `signApp` walks `resources/app.asar.unpacked` with that test. As a result:
  - `resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node`
    (a DLL the main process loads) stays unsigned even with `SSW_REQUIRE_SIGNING=1`;
  - `verify-dist` checks only the app exe and the installer. It would not notice an unsigned
    `ffmpeg.exe`, `resources/native/ssw-capture.exe`, uninstaller or `.node`.

  `docs/BUILDING.md` says signing covers "the app exe, `ffmpeg.exe`, the native helper,
  `elevate.exe`, the uninstaller and the installer". The `.node` file is not in that list.
- **Failure scenario:** a release build passes `verify-dist` with `SSW_REQUIRE_SIGNING=1`.
  - On a PC with Smart App Control or a WDAC policy that requires signed code, the unsigned
    `.node` can be blocked. The input hook then fails to load, and there is no click detection or
    auto zoom.
  - A later change to signing (for example `signExts` excluding `.exe`) could ship an unsigned
    `ffmpeg.exe` without any check failing.
- **Fix:**
  - Add `signExts: ['.node']` to `win` in `electron-builder.config.cjs`.
  - In `verify-dist.mjs`, when signing is required, check `parsePe(...).signed` for every `.exe`
    and `.node` under `win-unpacked/resources`, plus `ffmpeg.exe` and the helper, by walking the
    tree.

### F5 (medium): `ffmpeg.exe` is downloaded and then signed with the release certificate, with no integrity check

- **Where:** `scripts/predist.mjs:36-69`; `node_modules/ffmpeg-static/install.js` (no hash
  verification).
- **Problem:**
  - predist accepts any `node_modules/ffmpeg-static/ffmpeg.exe` that passes `checkWindowsExe`
    (x64 PE, at least 20 MB). Otherwise it runs ffmpeg-static's `install.js`, which downloads
    whatever `FFMPEG_BINARIES_URL` / `FFMPEG_BINARY_RELEASE` (both read from the environment)
    or GitHub returns. Nothing compares it to a known hash.
  - electron-builder then signs that file with the publisher's certificate (F4's walk of
    `app.asar.unpacked`).
- **Failure scenario:** a tampered `ffmpeg.exe` reaches the build machine, through a mirror set in
  the environment, a poisoned cache, or a modified `node_modules`. It is shipped and signed under
  the company's name, and every export and recording runs it. A truncated-but-valid PE larger than
  20 MB also passes.
- **Fix:**
  - Pin the SHA-256 of `ffmpeg-win32-x64` for the release tag in
    `scripts/lib/packaging.cjs`.
  - Check it in `predist` (after any download) and again in `verify-dist` against
    `win-unpacked/.../ffmpeg.exe`.
  - When `SSW_REQUIRE_SIGNING=1`, refuse to build if `FFMPEG_BINARIES_URL` or
    `FFMPEG_BINARY_RELEASE` is set and the hash does not match.

### F6 (low): `cursor.json` is rewritten in place, so a failed write loses all cursor data

- **Where:** `src/main/projects.ts:59-61` (`writeCursor` uses plain `fs.writeFile`). Called from
  `src/main/recording/finalize.ts:245-246`, which reads, clamps and rewrites the file on every
  processing and recovery, and from `recordingIpc.ts:340`.
- **Problem:** every other state file goes through `writeFileAtomicSync`. `cursor.json` can be
  several MB for long recordings, and it is truncated and rewritten in place.
- **Failure scenario:** the disk fills, the PC loses power, or the app is killed during
  "Finishing…". `cursor.json` is left truncated, and `readCursor` swallows the parse error and
  returns an empty, invalid track. The project then opens with no smooth cursor, no click ripples
  and no auto zoom, permanently, because the raw recording is already deleted. Recovery after a
  crash rewrites the same file in place too.
- **Fix:** `writeFileAtomicSync(path.join(projectDir(id), 'cursor.json'), JSON.stringify(track), { attempts: 4 })`
  (or an async temp file plus rename).

### F7 (low): Picking a background or cursor image overwrites the file in use in place, and the background pick is not checked at all

- **Where:** `src/main/projectsIpc.ts:91-106` (`projects:pickBackground`) and `:154-170`
  (`importCursorImage`).
- **Problem:** both copy straight onto `background.<ext>` / `cursor.<ext>`, the file the project
  may currently use. `importAsset` (`assetIpc.ts:131-138`) avoids exactly this with a `.part`
  file and a new name.

  `pickBackground` also has no size, type or extension check. A name typed into the dialog
  bypasses its filter, for example `notes.txt`, which is copied as `background.txt`, or a
  multi-GB file is copied whole.
- **Failure scenario:** the user picks a new PNG background while `background.png` is in use, and
  the copy fails partway (source on a USB stick or network drive that disconnects, or a full
  disk). The in-use `background.png` is left truncated, so the old background is gone and undo
  cannot bring it back.
- **Fix:**
  - Copy to `.<name>.part` and `fs.rename` it into place, as `importAsset` does.
  - In `pickBackground`, reuse `importCursorImage`-style checks: an extension from the allowed
    list, `stat().isFile()`, a size cap, and `imageType(head)` matching the extension.

### F8 (low): No Electron fuses are set, and `SSW_CAPTURE_HELPER` is honoured in packaged builds

- **Where:** `electron-builder.config.cjs` (no `electronFuses`); `src/main/nativeCapture.ts:201-209`.
- **Problem:** the packaged, and once configured signed, `Screen Studio for Windows.exe` keeps the
  `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` fuses on.
  It also has no asar integrity check or `onlyLoadAppFromAsar`. `SSW_CAPTURE_HELPER` is a test hook
  but is not gated by `app.isPackaged` (the `__SSW_NATIVE_CAPTURE__` hook next to it is).
- **Failure scenario:**
  - `ELECTRON_RUN_AS_NODE=1 "Screen Studio for Windows.exe" payload.js` runs arbitrary JS under
    the publisher's signature. This is a common way to get past application allowlisting.
  - Swapping `app.asar` changes the code a signed exe runs, without breaking its signature.
- **Fix:**
  ```js
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  }
  ```
  Also read `SSW_CAPTURE_HELPER` only when `!app.isPackaged`. The app itself uses
  `ELECTRON_RUN_AS_NODE` only for that test override, so production is unaffected; the
  `packaging.e2e` test should be re-run once the fuses are on.

### F9 (low): All three windows run with `sandbox: false`, though the preload needs nothing beyond `electron`

- **Where:** `src/main/windows.ts:48`, `src/main/recording/toolbarWindow.ts:25`,
  `src/main/recording/regionWindow.ts:37`.
- **Problem:** the built preload (`out/preload/index.js`) only does `require("electron")` and uses
  `contextBridge`, `ipcRenderer` and `process.platform`. All three work in a sandboxed preload.
  Turning the sandbox off gives every renderer an unsandboxed process for no functional reason,
  which makes F3 or any renderer exploit worse.
- **Fix:** set `sandbox: true` in the three windows (or leave it out; it defaults to true since
  Electron 20). Then run the e2e suite; nothing in the preload should need changing.

## Constraints the wave 3 changes must respect

- **CSP (`src/renderer/index.html:8`):**
  - For the segmentation WASM, add only `'wasm-unsafe-eval'` to `script-src`, never
    `'unsafe-eval'`.
  - Ship the model and `.wasm` inside `out/renderer` and load them from `'self'`, not from a CDN,
    so the model works offline and needs no `connect-src` change.
  - A worker built from a `blob:` URL also needs `worker-src 'self' blob:`. Today
    `default-src 'self'` covers only same-origin workers.
  - While editing the CSP, drop `ws://localhost:*` from production `connect-src` (it is only for
    dev HMR).
  - WebGL tilt needs no CSP change.
- **Title cards and chapter metadata in exports:**
  - Pass user text to ffmpeg only as separate `spawn` arguments (`-metadata title=...`) or inside
    an `;FFMETADATA1` file whose values escape `=`, `;`, `#`, `\` and newlines. Otherwise a
    chapter title can add keys or chapters.
  - Never put user text inside `-filter_complex` (for example `drawtext=text=...`). A `;` or `[`
    there can inject other filters, some of which read or write files (`movie=`, `amovie=`,
    `metadata=...:file=`).
  - Keep drawing titles in the compositor, as overlays are today.
  - Extend `validateJob` for any new field (lengths, counts, numbers).
- **Recording presets and new preference keys:**
  - Add them to `PREF_KEYS` and validate them on read, as the other prefs are.
  - A preset must not carry file paths or capture source ids that main trusts without
    `resolveSource`.
- **New windows (for example a camera preview):** create them through the guard in F3 with
  `sandbox: true`, and give them no new IPC that skips the sender checks recommended in F3.
- **New project files (for example a model cache or chapter thumbnails):** extend `MEDIA_FILE_RE`
  with exact names only. Write them with a temp file and rename (F6, F7), never in place.

## Checked and fine

- **Project id handling:** `projectDir` with `ID_RE` (`/^[a-zA-Z0-9_-]+$/`) blocks traversal on
  every id-taking handler (`projects:*`, `export:start`, `export:analyzeAudio`,
  `projects:detectStill`, `recordings:recover`, `studio-media://`). Invalid ids throw before any
  file access or dialog.
- **`studio-media://` (`mediaProtocol.ts`):**
  - the file name is checked by an anchored whitelist, so no slashes or `..`;
  - a malformed percent-escape returns 404;
  - range edge cases are handled (`bytes=-0` and `0-` on an empty file give 416, an end past the
    file is clamped);
  - user SVGs get `default-src 'none'` and `nosniff`.
- **Export paths (`exportIpc.ts`):**
  - `export:start` accepts only the dialog-approved path or a once-only batch path;
  - `batchFileOk` rejects separators, reserved characters, leading dots, trailing dots and spaces,
    and unknown extensions;
  - batch exports never overwrite;
  - output goes to a hidden `.partial-` file and is renamed into place;
  - thumbnails must be PNG, at most 200 MB, at the approved path only;
  - the clipboard action accepts only files exported in this session.
- **ffmpeg arguments:**
  - `validateJob` checks every number, enum, list length and the music file name;
  - all sound inputs come from fixed names inside the project folder;
  - long graphs go through `-filter_complex_script` in temp files that are logged and swept;
  - every `spawn` uses an argument array with no shell.
- **Temp-file clean-up:** the startup sweep deletes only names matching the export temp patterns
  (`isExportTempFile`, absolute paths). The temp-folder sweep skips live process ids and files
  younger than 10 minutes.
- **PowerShell clipboard copy:** the path travels in an environment variable to a fixed script
  (`Set-Clipboard -LiteralPath $env:SSW_CLIPBOARD_FILE`), with the absolute `System32` path and no
  shell. osascript gets the path as an argv item. X11 and Wayland get it on stdin.
- **Asset picks (`assetIpc.ts`):**
  - kind whitelist;
  - extension, `isFile`, size and magic-byte checks (an SVG must be an SVG);
  - a new name for every pick, copied through `.part` plus rename;
  - pruning never removes the pick in use or the saved one.
- **Prefs:** key whitelist, 2 MB per value, atomic write. Style defaults and app settings are
  sanitised on read and on write. Hotkeys are validated before `globalShortcut.register`.
- **Recording IPC:**
  - every session call needs the random session token;
  - chunk kinds are whitelisted;
  - regions are sanitised against the display;
  - `region:done` is accepted only from the region window's `webContents`;
  - the display-media handler grants only the source validated in `recording:prepare`, and only
    for one request.
- **Deletes:** `deleteProject` validates the id and stops analyses first. `fs.rm` removes a
  junction or symlink inside a project folder without following it.
- **Native helper:** spawned without a shell, with arguments built from validated values
  (`windowHandleOf` range-checks the HWND, the display comes from Electron, the output path is
  inside the project). The CLI parser rejects malformed flags (`native/src/cli.rs` tests). Stdout
  is capped at 256 KB.
- **Single instance:** the lock is taken before anything registers. A second launch only focuses
  the app or the toolbar.
- **Packaging:**
  - `app.asar` contents, locales, foreign prebuilds and the GPL files for `ffmpeg.exe` are
    enforced by `verify-dist`;
  - the native helper is bundled through the directory form (so it is signed) only when it is a
    complete x64 PE;
  - signing configuration errors stop the build.
- **Dependencies:** `npm audit` reports 0 vulnerabilities (prod and dev). Electron 44.9.3 is
  current for the 44 line.
- **ffmpeg and playlist files:** a project's `screen.mp4`/`screen.webm` replaced by an HLS
  playlist is **refused** by the Linux `ffmpeg-static` binary installed here (7.0.2: "Not
  detecting m3u8/hls with non standard extension"). I could not run the Windows binary
  (`b6.1.1` release tag), so check once on Windows that it refuses
  `ffmpeg -i screen.mp4` holding an `#EXTM3U` playlist. If it does not, add
  `-protocol_whitelist file,pipe` to the input-side arguments in `analysisIpc.ts`,
  `audioAnalysis.ts`, `proxyArgs.ts` and `exportArgs.ts`.
