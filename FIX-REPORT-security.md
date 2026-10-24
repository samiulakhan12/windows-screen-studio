# Fix report: security and packaging audit (F3, F4, F5, F7, F8, F9)

Base: `f3db4cb` (waves 1-2 and three of the four wave-3 parts). Findings from
`origin/audit-security-packaging:audit/security-packaging.md`, which was written against `b25a136`.
Every finding was checked again against `f3db4cb` before it was fixed. All six still applied.

| Id | Status | Proof (fails without the fix) |
| --- | --- | --- |
| F3 | fixed | `tests/security.test.ts`, `tests/e2e/audit-security.e2e.cjs` (both tests) |
| F4 | fixed | `tests/packaging.test.ts`: "signs the uiohook-napi .node besides every .exe", "lists every .exe and .node file of a packaged app folder as needing a signature" |
| F5 | fixed | `tests/packaging.test.ts`: "checkWindowsExe with a pin accepts only that build, before and after signing", "pins the ffmpeg.exe of the release ffmpeg-static downloads"; manual predist run with a tampered file (below) |
| F7 | fixed | `tests/pickedImages.test.ts` (5 tests) |
| F8 | fixed | `tests/nativeCapture.test.ts` "ignores SSW_CAPTURE_HELPER in a packaged app"; `tests/packaging.test.ts` "turns off running as Node, NODE_OPTIONS and --inspect, and checks app.asar integrity" |
| F9 | fixed | `tests/e2e/audit-security.e2e.cjs` (asserts `sandbox: true` for every window and a working `window.api`) |

"Fails without the fix" was checked for each one. For the unit tests, the source change was stashed
and the test run again. For the e2e file, `src/` was stashed and rebuilt; both e2e tests failed:
the evil page loaded in the main window, and the old handler refused the app page's clipboard write.
The test now checks the other page first, so on old code it fails on the security problem itself.

## F3: navigation was not restricted; any page got capture permissions

Still applied: no `will-navigate`/`will-redirect` handler anywhere, no window-open handler on the
toolbar and region windows, and `setPermissionRequestHandler` granted `media`/`display-capture` to
any page (it had moved to `recordingIpc.ts` `setupDisplayMedia`).

Changes:
- New `src/main/security.ts`:
  - `isAppUrl(url)` accepts only the built `out/renderer/index.html` at any hash route. It compares
    the file path, case-insensitively on Windows. While developing, it accepts the dev server's
    origin instead.
  - `guardWebContents` is attached to every webContents through `web-contents-created`. It cancels
    `will-navigate` and `will-redirect` to any other URL and denies `window.open`. `windows.ts`
    still installs its own handler on the main window, which sends https links to the browser.
  - The permission request handler allows `media`, `display-capture` and
    `clipboard-sanitized-write`, and only when the requesting URL is the app page.
  - The permission check handler answers true only for the app page. Checks with no webContents
    are denied; the renderer has no workers.
  - `registerSecurity()` is called first in `whenReady` in `index.ts`.
- `recordingIpc.ts`: the old allow-all permission handler is removed. The display-media handler
  also refuses requests from frames that are not the app page, so another page cannot use up a
  pending grant.
- `src/renderer/src/main.tsx`: `dragover` and `drop` are cancelled at the document, so a dropped
  file does not replace the app. Main blocks that navigation too.

Everything the app uses still works:
- getDisplayMedia/desktopCapturer (smoke, recording, recording-options);
- camera and microphone (recording-options with fake devices; the e2e checks getUserMedia on the
  app page without the fake-UI flag);
- the Home camera preview (same `media` permission and page);
- clipboard writes for Copy chapters. `navigator.clipboard.writeText` now works directly; before,
  the old handler refused it and the app fell back to `execCommand('copy')`;
- WebGL (tilt e2e);
- `studio-media://` (editor and export e2e).

WebGL and media loads are not permission requests.

## F4: unsigned uiohook-napi.node; verify-dist checked two files

Still applied: no `signExts` in `electron-builder.config.cjs`; verify-dist checked only the app exe
and the installer.

Changes:
- `scripts/lib/packaging.cjs`:
  - `SIGN_EXTS = ['.node']`, used as `win.signExts` in `electron-builder.config.cjs`.
    electron-builder 26.15.3 `shouldSignFile` then signs `.exe` plus `.node`.
  - `signedFiles(dir)` lists every `.exe` and `.node` under a folder.
- `scripts/verify-dist.mjs` section 6: when `SSW_REQUIRE_SIGNING=1`, the build fails if the
  installer or any `.exe`/`.node` in `win-unpacked` is unsigned:
  - the app exe;
  - `resources/elevate.exe`;
  - `ffmpeg.exe`;
  - the native helper;
  - `uiohook-napi.node`.

  Without that variable it prints the unsigned files as a note.
- The uninstaller is generated inside the installer and is not a separate file in `dist/`, so it is
  still covered only through the installer's own signature (unchanged).
- `docs/BUILDING.md` is updated.

## F5: ffmpeg.exe was not integrity-checked

Still applied: predist accepted any x64 PE of at least 20 MB, and ffmpeg-static's `install.js`
honours `FFMPEG_BINARIES_URL`/`FFMPEG_BINARY_RELEASE`.

Changes:
- `scripts/lib/pe.cjs`:
  - `peContentHash(buf, length)` is a SHA-256 that reads the two header fields signing rewrites
    (the checksum and the certificate-table entry) as zeros.
  - `checkWindowsExe(file, { pin })` accepts the unsigned file, or the same file after signing
    (padding of at most 7 zero bytes, then the certificate table), and nothing else.
  - The pin therefore holds both in predist (unsigned) and in verify-dist (signed).
- `scripts/lib/packaging.cjs` `FFMPEG_EXE`:
  - `release: 'b6.1.1'`, `size: 82797568`,
    `sha256: 'b146ee98b213af232337d8fa6574eeaee2d58b90e7832f338c06e7d9f1436f30'` (content hash).
  - The plain SHA-256 of the unsigned file is
    `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`.
  - Source: `ffmpeg-win32-x64.gz` downloaded over HTTPS from the GitHub release `b6.1.1`.
    ffmpeg-static's own `install.js` produced the same bytes in a second download.
  - I could not compare against a published digest: the release API was not reachable from this
    session. **Check the plain SHA-256 above once on a trusted machine.**
- `scripts/predist.mjs`:
  - stops if ffmpeg-static's `binary-release-tag` no longer matches the pin;
  - replaces any existing file that does not match;
  - strips `FFMPEG_BINARY_RELEASE` from the installer's environment;
  - fails, deleting the file, if a download (mirror or not) does not match. This applies to every
    build, not only `SSW_REQUIRE_SIGNING=1` builds: an unknown ffmpeg is never wanted.
- `scripts/verify-dist.mjs` checks the packaged `ffmpeg.exe` against the same pin.
- Manual check: one byte of `node_modules/ffmpeg-static/ffmpeg.exe` was changed, then predist was
  run. It printed "unusable (not the expected build ...); downloading it again" and ended with
  "SHA-256 matches the b6.1.1 pin".

## F7: background/cursor picks overwrote the file in use; background pick unchecked

Still applied, unchanged since `b25a136`.

Changes in `src/main/projectsIpc.ts`:
- `copyIntoProject` copies to `.<name>.part` and renames it into place. The temporary file is
  removed on failure, the way `importAsset` does it. Both picks use it.
- New `importBackgroundImage`, used by `projects:pickBackground`:
  - the extension must be png, jpg/jpeg or webp;
  - the pick must be a regular file of at most 100 MB;
  - its first bytes must be that format (`imageType` from `assetIpc.ts`).
- `importCursorImage` also requires a regular file now.
- `Editor.tsx` shows a refused background pick as a notice instead of an unhandled rejection.

Names stay `background.<ext>` / `cursor.<ext>`, so `MEDIA_FILE_RE` and saved projects are
unchanged.

## F8: no Electron fuses; SSW_CAPTURE_HELPER honoured when packaged

Still applied.

Changes:
- `electron-builder.config.cjs` `electronFuses` (electron-builder 26 flips them before signing):
  - `runAsNode: false`;
  - `enableNodeOptionsEnvironmentVariable: false`;
  - `enableNodeCliInspectArguments: false`;
  - `enableEmbeddedAsarIntegrityValidation: true`;
  - `onlyLoadAppFromAsar: true`.

  electron-builder 26.15.3 embeds the asar integrity resource in the Windows exe (`addWinAsarIntegrity`).
- The app never needs `ELECTRON_RUN_AS_NODE` when packaged: `nativeCapture.ts` used it only for
  the `.js` helper override, which is now gated.
- `src/main/nativeCapture.ts` reads `SSW_CAPTURE_HELPER` only when `!app.isPackaged`, like
  `__SSW_NATIVE_CAPTURE__`. `native/README.md` and `docs/BUILDING.md` are updated.

## F9: windows ran with sandbox: false

Still applied in all three windows. They are now `sandbox: true`. The built preload
(`out/preload/index.js`) still requires only `electron`.

## Constraints the camera part must follow when it is merged

- CSP (`src/renderer/index.html`):
  - add only `'wasm-unsafe-eval'` to `script-src`, never `'unsafe-eval'`;
  - a worker from a `blob:` URL also needs `worker-src 'self' blob:`;
  - drop `ws://localhost:*` from production `connect-src` while editing the CSP.
- Ship the segmentation model and `.wasm` inside `out/renderer`, which is inside `app.asar`, and
  load them from `'self'`, never from a CDN.
  - Do not add them to `asarUnpack`: with `onlyLoadAppFromAsar` and asar integrity on, only
    `app.asar` is integrity-checked.
  - `scripts/verify-dist.mjs` should assert they are in the asar.
- Merge points with this branch:
  - `electron-builder.config.cjs`: I added `electronFuses` (after `forceCodeSigning`) and
    `win.signExts`. Keep both.
  - `scripts/verify-dist.mjs`: I changed sections 2 (ffmpeg pin) and 6 (signature walk). New
    model/WASM checks belong in a new section. Any `.exe`/`.node` the camera part adds is signed
    and verified automatically. `.wasm` and model files are not PE files and need no signing.
- Windows run sandboxed now. Segmentation must run in the renderer (WASM/WebGL) or in a worker,
  never through Node in the preload. A sandboxed preload can `require` only `electron`.
- A new window (for example a separate camera preview) must load the app page through
  `loadRoute(win, '#/...')` with `sandbox: true`.
  - Any other URL is blocked by the navigation guard.
  - A page that is not `out/renderer/index.html` is refused the camera.
  - If such a window opens links, give it its own `setWindowOpenHandler`.
- The camera must be opened from the app page (`getUserMedia`, permission `media`). No new
  permission type is allowed; if the camera part needs one, add it to `PERMISSIONS` in
  `src/main/security.ts` with a reason.
- The renderer now cancels `dragover`/`drop` at the document. A drop zone, if one is added, must
  handle the event on its own element.
- New project files (a model cache, thumbnails): add exact names to `MEDIA_FILE_RE`, and write them
  with a temporary file and a rename (`copyIntoProject` in `projectsIpc.ts`, or
  `writeFileAtomicSync`), never in place.
- New IPC from a new window must check `event.sender` the way `region:done` does.

## Verification

All runs are on the final tree, with openbox installed for the window tests.

- `npm run typecheck`: passed.
- `npx vitest run`: 84 files, 1212 tests passed.
- `npm run build`: passed.
- e2e, one file at a time under `xvfb-run -a -s "-screen 0 1920x1080x24"`:

  | File | Result |
  | --- | --- |
  | audit-security.e2e.cjs (new) | 2/2 PASS |
  | smoke.e2e.cjs | 1/1 PASS |
  | packaging.e2e.cjs | 2/2 PASS (dist check skipped: no `dist/`) |
  | editor.e2e.cjs | 13/13 PASS |
  | recording.e2e.cjs | 9/9 PASS |
  | recording-options.e2e.cjs | 4 PASS, 1 SKIP (wine desktop-icons test: needs wine and the native helper, same as before) |
  | style-pack.e2e.cjs | 7/7 PASS |
  | tilt.e2e.cjs | 6/6 PASS |
  | titles.e2e.cjs | 6/6 PASS |

  The suite ran on a build that differed from the final tree only by one blank line in
  `recordingIpc.ts`. audit-security was run again on the final build and passed.
- **Packaging.** `npm run dist:win` cannot finish here: wine is not installed, and electron-builder
  on Linux runs the NSIS installer under wine to extract the uninstaller. I validated the config
  in these steps instead:
  1. `npm run predist` passed. It downloaded the Windows `ffmpeg.exe` and printed
     "SHA-256 matches the b6.1.1 pin". A tampered file was replaced, as described under F5.
  2. `electron-vite build`, then
     `npx electron-builder --win --x64 --dir --config electron-builder.config.cjs`. This is the
     same config and the same packaging steps, without the NSIS target. It exited 0, logging
     "updating asar integrity executable resource", "executing @electron/fuses" and a signing step
     for the app exe, `uiohook-napi.node` and `ffmpeg.exe`. Signing is a no-op without a
     certificate.
  3. `@electron/fuses` `getCurrentFuseWire` on the produced exe:
     - RunAsNode off;
     - EnableNodeOptionsEnvironmentVariable off;
     - EnableNodeCliInspectArguments off;
     - EnableEmbeddedAsarIntegrityValidation on;
     - OnlyLoadAppFromAsar on.
  4. The exe's embedded integrity resource
     (`[{"file":"resources\\app.asar","alg":"SHA256","value":"11de74..."}]`) equals the
     SHA-256 of the produced `app.asar` header.
  5. `node scripts/verify-dist.mjs` on that output: every check passed (asar contents, ffmpeg pin,
     prebuilds, locales, icon) except "installer is missing", which is expected for `--dir`.
     With `SSW_REQUIRE_SIGNING=1` it also failed with "code signing required but UNSIGNED: <app
     exe>, ffmpeg.exe, uiohook-napi.node, installer". Before this change it would have named only
     the exe and the installer.
  6. `dist/` was then removed.

  Not verified here, and still to do on Windows or with wine:
  - the NSIS installer build;
  - a signed build;
  - launching the fused, packaged exe. Asar integrity and `onlyLoadAppFromAsar` take effect only
    at run time.

  Run `npm run dist:win` and then launch the installed app once before release.
