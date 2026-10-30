# Building, packaging and signing

This page covers everything between a source checkout and a Windows installer you can hand out:
the toolchain, `npm run dist:win`, what ends up in the package, the app icon, the optional native
helpers (screen capture and speech) and code signing.

## Requirements

| What | Version | Why |
| --- | --- | --- |
| Node.js | **20.19+ or 22.12+** (`^20.19.0 \|\| >=22.12.0`, also in `package.json` `engines`) | Vite 7, electron-vite 5 and `@vitejs/plugin-react` 5 refuse older versions |
| npm | the one that comes with Node | the lockfile is `package-lock.json` (v3) |
| Windows 10 2004+ or 11, x64 | | to run the app and the installer |
| Wine 64- and 32-bit (Linux/macOS only) | any recent | electron-builder runs `rcedit` under Wine to put the icon and version info into the `.exe` |
| Rust (optional) | **1.88+**, with `rustup target add x86_64-pc-windows-gnu`; see `native/README.md` | builds the native capture helper `ssw-capture.exe` and the speech helper `ssw-speech`; `cargo` also lists the Rust crates for the third-party notices (required for release builds) |
| MinGW-w64, POSIX threads (optional; Linux/macOS) | `x86_64-w64-mingw32-gcc-posix`, `g++-posix` (Ubuntu: `apt install mingw-w64`) | links the Windows helpers; the speech helper needs the POSIX-thread variant |
| cmake (optional) | **3.28+** | builds whisper.cpp inside the speech helper |
| clang and libclang (optional) | 18 (Ubuntu: `apt install clang libclang-dev`, or set `LIBCLANG_PATH`) | bindgen reads whisper.cpp's header |
| Wine 64-bit (optional) | any recent | `scripts/smoke-speech-wine.sh` runs the Windows speech helpers |

The first `npm run dist:win` downloads Electron for Windows, NSIS, electron-builder's signing tools
and, when you are not on Windows, the Windows `ffmpeg.exe` (about 30 MB). Later builds use the caches.

## Everyday commands

```bash
npm install
npm run dev          # the app with hot reload
npm test             # unit tests (vitest)
npm run typecheck
npm run build        # compile main, preload and renderer into out/
xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e   # end-to-end tests of the built app (Linux)

# the speech helper (captions on this PC, the speech detector); see "The speech helper" below
npm run build:speech-host   # native/bin/ssw-speech for this machine (development and tests)
npm run fetch:test-speech   # the test model (43.5 MB) into .cache/test-speech/, checked
npm run test:native         # the helper's tests (tests/native/*.spec.ts)
```

## Building the installer

```bash
npm run dist:win     # -> dist/Flown-Setup-<version>.exe
```

It also writes `dist/latest.yml` (the update metadata a release carries) and, inside the app,
`resources/app-update.yml` (where Flown looks for updates: this repository's GitHub releases). It
never uploads anything: releases are made by the *Release* workflow as drafts that a person
publishes, see [RELEASING.md](RELEASING.md).

The same command works on Windows, Linux and macOS. It runs four steps and stops at the first one
that fails:

1. **`npm run predist`** (`scripts/predist.mjs`) checks everything the package needs *before*
   packaging, so a broken installer is never produced silently:
   - **ffmpeg.exe.** `ffmpeg-static` only downloads the build machine's own binary, so on
     Linux/macOS (or when `node_modules/ffmpeg-static/ffmpeg.exe` is missing, cut short or not an
     x64 Windows program) predist runs ffmpeg-static's own `install.js` with
     `npm_config_platform=win32 npm_config_arch=x64` to fetch it. If that fails the build stops with
     an error and instructions; it never ships an installer without ffmpeg. The file is signed with
     the release certificate, so only the build pinned by SHA-256 in `scripts/lib/packaging.cjs`
     (`FFMPEG_EXE`) is accepted: any other file is replaced, and a download that does not match
     stops the build. Update the pin when ffmpeg-static's `binary-release-tag` changes.
   - **Native helpers.** If `scripts/build-native.mjs` exists, predist runs it
     (`npm run build:native` does the same on its own): the capture helper and the two speech
     helpers. Without a Rust toolchain, or if a build fails, this is only a warning: the app then
     records through Chromium, with the OS cursor in the video, captions offer AI providers only
     and the speech detector falls back to sound levels. Set `SSW_REQUIRE_NATIVE=1` to make a
     missing helper an error (release builds). On Windows the speech helpers are not built: the
     ones you built on Linux or macOS and copied to `native/bin` are bundled (with a warning that
     they were not rebuilt), also with `SSW_REQUIRE_NATIVE=1`. Helpers built from older sources
     (one without an option the app passes, such as `--no-timestamps` for the Bangla model) are
     never bundled: predist and verify-dist fail with "… was built from older sources". Copy in the
     helpers built from the same commit.
   - **Speech detector model and notices.** `resources/speech/ggml-silero-v6.2.0.bin` must match
     its pin, and `resources/THIRD_PARTY_NOTICES.txt` must be what `npm run notices` generates now
     (`scripts/notices.mjs --check`). It lists the Rust crates with `cargo`; without `cargo` it
     keeps the Rust crates' section of the committed file with a warning and checks the rest,
     except with `SSW_REQUIRE_NATIVE=1`, where a missing `cargo` is an error.
   - **Icons** (`build/icon.ico` with 16-256 px, `build/installerSidebar.bmp`).
   - **Code signing variables** (see below; unsigned is fine).
2. **`electron-vite build`** compiles the app into `out/`.
3. **`electron-builder --win --x64 --config electron-builder.config.cjs`** packages it. The
   configuration is a JS file because signing and the native helper depend on the environment.
   electron-builder does not find `electron-builder.config.cjs` by itself, so always build through
   `npm run dist:win` (or pass `--config electron-builder.config.cjs`). It also sets the exe's
   Electron fuses: no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, and only the
   `app.asar` whose header hash is embedded in the exe is loaded.
4. **`npm run verify:dist`** (`scripts/verify-dist.mjs`) inspects the result and fails if
   `app.asar` holds anything but `out/`, `package.json` and the runtime `node_modules`, if
   `ffmpeg.exe` is missing, not x64 or not the pinned build, if other platforms' binaries or
   locales slipped in, if `build/icon.ico` lacks a Windows size or the exe or the installer does
   not carry it, if their file properties do not name Flown and Qbexel (CompanyName, ProductName,
   FileDescription, LegalCopyright, read from the version resource), if a speech helper is not an
   x64 executable or imports anything but KERNEL32, ADVAPI32, msvcrt, ntdll,
   api-ms-win-core-synch-l1-2-0 and bcryptprimitives, if the speech detector model is not the
   pinned one, if `THIRD_PARTY_NOTICES.txt` is missing, under 10 KB or does not name whisper.cpp,
   ggml, Silero VAD, OpenAI Whisper, mingw-w64, FFmpeg, Electron, React and MediaPipe, if the speech
   payload (both helpers, the model and its MODEL.md, the notices) exceeds 3.5 MB brotli-compressed
   (quality 11, 16 MB window) or 10 MB installed, or if signing
   was required but the installer or any `.exe` or `.node` file in `win-unpacked` is unsigned. It ends with the installer and install sizes.

On Linux, keep Wine's console noise down with `WINEDEBUG=-all npm run dist:win`.

### What the package contains

| Where (installed) | What |
| --- | --- |
| `Flown.exe` + Chromium files | Electron 44, the Flown icon embedded; file properties: Flown by Qbexel |
| `locales/en-US.pak` | the only Chromium locale (the UI is English; the other 54 were ~50 MB) |
| `resources/app.asar` | `out/` (no source maps), `package.json`, and from `node_modules` only `ffmpeg-static` (`index.js`), `uiohook-napi` and `node-gyp-build` |
| `resources/app.asar.unpacked/node_modules/ffmpeg-static/` | `ffmpeg.exe` with its `LICENSE` and `README` (the GPL requires them) |
| `resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/` | the global mouse hook (no other platforms' prebuilds) |
| `resources/native/ssw-capture.exe` | the native capture helper, when it was built |
| `resources/native/ssw-speech.exe`, `ssw-speech-compat.exe` | the speech helper (standard build for AVX2 processors, compatible build for any x64 processor), when they were built |
| `resources/speech/ggml-silero-v6.2.0.bin`, `MODEL.md` | the speech detector model (885 KB, pinned by SHA-256) |
| `resources/THIRD_PARTY_NOTICES.txt` | the third-party notices, shown from About (`npm run notices`) |

The source tree, tests, docs, configs and the packages `ffmpeg-static` needs only to *download*
ffmpeg (`@derhuerst/http-basic`, `https-proxy-agent`, ... and their own nested `node_modules`) are
excluded. `scripts/lib/packaging.cjs` computes that list from `package.json`, so it stays right when
dependencies change.

Sizes measured on the same code (Linux cross-build, NSIS `compression: maximum`):

| | Before (`electron-builder.yml`) | After | Change |
| --- | --- | --- | --- |
| Installer | 133.7 MB | 113.3 MB | -20.4 MB (-15 %) |
| Installed (`dist/win-unpacked`) | 470.6 MB | 420.0 MB | -50.6 MB (-11 %) |
| `app.asar` | 934 KB (with `src/`, `tests/`, `docs/`...) | 375 KB | |
| Chromium locales | 50.6 MB (55 files) | 0.6 MB (en-US) | |

"After" includes the 424 KB native helper. Most of what is left is Electron itself (the exe alone is
247 MB) and ffmpeg.exe (83 MB, the full GPL "essentials" build).

### Cross-building from Linux or macOS

Install Wine (both 64- and 32-bit) and run `npm run dist:win`. Nothing else is manual: predist
fetches the Windows `ffmpeg.exe` itself. Without network access, download `ffmpeg-win32-x64.gz` for
the release tag in `node_modules/ffmpeg-static/package.json` (`b6.1.1` today) from
<https://github.com/eugeneware/ffmpeg-static/releases>, gunzip it to
`node_modules/ffmpeg-static/ffmpeg.exe`, or point `FFMPEG_BINARIES_URL` at a mirror. Either way the
file must match the SHA-256 pin.

The native helpers cross-compile too (`rustup target add x86_64-pc-windows-gnu` and MinGW-w64;
the speech helper also cmake, libclang and the POSIX-thread MinGW); see `native/README.md` and
"The speech helper" below. The speech helpers are only cross-compiled from Linux or macOS; to
package on Windows, copy both exes, built from the same commit, into `native/bin` first.

## The app icon

The icon is the Flown app icon from Qbexel's brand kit: the gradient "F" mark on an Ink tile. The
masters are in `assets/brand/` (see `assets/brand/BRAND.md` for the colours and usage rules):

| File | Use |
| --- | --- |
| `assets/brand/flown-app-icon.svg` | master artwork, used for 48 px and up |
| `assets/brand/flown-app-icon-small.svg` | the kit's under-48 px art (flat gradient, wider gap between the blades) for 16-40 px |
| `build/installer-sidebar.svg` | the installer's welcome/finish page image (the kit's mark and wordmark on Ink) |
| `build/icon.ico` *(generated)* | 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256 px: exe, installer, uninstaller, shortcuts, taskbar |
| `build/icon.png` *(generated)* | 512 px: window icon in development, docs |
| `build/installerSidebar.bmp` *(generated)* | 164x314 NSIS sidebar |

After editing an SVG, regenerate the files with `npm run icons` (on Linux without a desktop:
`xvfb-run -a npm run icons`). The generator renders the SVGs with the project's own Electron, so no
image tools are needed, and writes the ICO itself (`scripts/icons/render-icons.cjs`,
`scripts/lib/ico.cjs`). Commit the generated files.

The installed app's shortcuts point at the exe, and packaged windows use the exe's embedded icon,
so `build/` is not shipped. In development `src/main/windows.ts` loads `build/icon.ico` (Windows) or
`build/icon.png` for the window.

## Upgrading installs of "Screen Studio for Windows"

The app was called "Screen Studio for Windows" (appId `com.samiulakhan12.screenstudio`) before it
became Flown (appId `com.qbexel.flown`). electron-builder derives the NSIS product GUID from the
appId, which would make the Flown installer a different product: it would install beside the old
app and leave it, its shortcuts and its uninstall entry in place. So `nsis.guid` in
`electron-builder.config.cjs` keeps the GUID of the old appId
(`25fa5926-dc93-5490-a32e-c16bd99d39ca`, UUID v5 in electron-builder's namespace; the unit test
recomputes it). Installing Flown over the old app then:

- finds the old install (`Software\{GUID}`), runs its uninstaller with `--updated /KEEP_APP_DATA`,
  which removes the old exe, its Desktop and Start menu shortcuts (`Screen Studio for Windows.lnk`)
  and keeps the user's data; `build/installer.nsh` deletes those shortcuts too if they are still
  there;
- installs to `...\Programs\Flown` instead of reusing the old `...\Programs\Screen Studio for Windows`
  folder (`build/installer.nsh`, `customInit` and a hidden page after the directory page); a folder
  the user had chosen under another name is kept;
- creates `Flown.lnk` shortcuts stamped with the AppUserModelID `com.qbexel.flown`, which the app
  sets at start (`APP_USER_MODEL_ID` in `src/shared/brand.ts`), so the taskbar groups the window
  with its shortcut. A taskbar pin of the old shortcut is removed with it; pin Flown again.

On the first start the app moves the old settings and recordings to Flown's folders (see
`docs/IMPLEMENTATION.md`, Data model).

## Code signing

Without a certificate the build is **unsigned**, which works but makes Windows SmartScreen warn
on first launch ("Windows protected your PC" -> More info -> Run anyway). Signing turns on by itself
as soon as the variables for **one** of the methods below are set, in the environment or in an
`electron-builder.env` file next to `package.json` (git-ignored; electron-builder and predist both
read it). No configuration change is needed. electron-builder then signs the app exe, `ffmpeg.exe`,
the native helper, `elevate.exe`, the input hook (`uiohook-napi.node`, through `win.signExts`), the
uninstaller and the installer with SHA-256, and timestamps
each signature so it stays valid after the certificate expires.

Release builds should set `SSW_REQUIRE_SIGNING=1`: the build then fails instead of quietly producing
an unsigned installer, and `verify:dist` checks the signatures.

### 1. Certificate file (`.pfx` / `.p12`)

```bash
CSC_LINK=C:\certs\flown.pfx       # path, https:// URL or base64 of the file
CSC_KEY_PASSWORD=...                     # the file's password
```

`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` take precedence if you also sign for other platforms.
Works on Windows (signtool) and on Linux/macOS (osslsigncode). On Linux, electron-builder's bundled
osslsigncode needs OpenSSL 1.1, which current distributions no longer ship: install `osslsigncode`
from your distribution and add `USE_SYSTEM_SIGNCODE=true`. (If it then crashes while
`HTTPS_PROXY` is set, which osslsigncode 2.8 receives as `-p`, unset `HTTPS_PROXY` and keep the
lower-case `https_proxy`, which osslsigncode reads by itself.)

Note: publicly trusted code-signing certificates issued since June 2023 must live on a hardware
token or cloud HSM, so you usually cannot get them as a `.pfx`. Use method 2 or 3 for those.

### 2. Certificate in the Windows certificate store (USB token, EV, cloud HSM)

On a Windows build machine where the certificate is installed (with its vendor's driver/KSP):

```powershell
$env:WIN_SIGN_CERT_SHA1 = "<certificate thumbprint>"   # or:
$env:WIN_SIGN_CERT_SUBJECT = "Your Name or Company"
```

### 3. Azure Trusted Signing

On a Windows build machine (electron-builder installs the `TrustedSigning` PowerShell module and
runs `Invoke-TrustedSigning`):

```powershell
$env:AZURE_TRUSTED_SIGNING_ENDPOINT  = "https://eus.codesigning.azure.net/"  # your account's region
$env:AZURE_TRUSTED_SIGNING_ACCOUNT   = "<code signing account name>"
$env:AZURE_TRUSTED_SIGNING_PROFILE   = "<certificate profile name>"
$env:AZURE_TRUSTED_SIGNING_PUBLISHER = "<publisher name, exactly the certificate's subject CN>"
# Microsoft Entra credentials of an app registration with the
# "Trusted Signing Certificate Profile Signer" role:
$env:AZURE_TENANT_ID = "..."; $env:AZURE_CLIENT_ID = "..."; $env:AZURE_CLIENT_SECRET = "..."
```

All four `AZURE_TRUSTED_SIGNING_*` variables are required once any is set. Without the Entra
variables, `Invoke-TrustedSigning` falls back to other sign-ins (Azure CLI, managed identity).

### Optional

- `WIN_SIGN_TIMESTAMP_URL`: another timestamp server. signtool and Azure use it as an RFC 3161
  server, osslsigncode (Linux/macOS) as an Authenticode one. The defaults are DigiCert's, which
  speaks both, and Microsoft's for Azure.

### Checking a signature

`npm run verify:dist` prints `Authenticode: installer and <n> file(s) in win-unpacked signed` (or
lists the unsigned files). On Windows, right-click
the installer -> Properties -> Digital Signatures, or run
`Get-AuthenticodeSignature .\dist\Flown-Setup-0.1.0.exe`.

## The native capture helper

`npm run build:native` builds `native/` (Rust) into `native/bin/ssw-capture.exe` (git-ignored). The
app finds it there in development and at `resources/native/ssw-capture.exe` when installed;
`npm run dist:win` builds and bundles it automatically when it can. It is only bundled if it is a
complete x64 Windows executable; a broken file is left out with a warning.

## The speech helper

`native/speech` (Rust around whisper.cpp 1.8.3, `native/speech/README.md`) is the sidecar behind
captions on this PC and the speech detector (`docs/design/offline-captions.md`). `npm run
build:native` builds it twice for Windows x64, each in its own target folder (whisper-rs-sys's build
script ignores changed environment variables):

| Build | Output | ggml flags |
| --- | --- | --- |
| Standard | `native/bin/ssw-speech.exe` | `GGML_NATIVE=OFF`, `GGML_SSE42/AVX/AVX2/FMA/F16C/BMI2=ON` (a cross build turns them all off otherwise: about 7.5 times slower) |
| Compatible | `native/bin/ssw-speech-compat.exe` | `GGML_NATIVE=OFF`, every x86 extension off (any x64 processor) |
| Host | `native/bin/ssw-speech` (`npm run build:speech-host`) | `GGML_NATIVE=OFF` on a native build (development, the native and end-to-end tests) |

The Windows builds use the POSIX-thread MinGW for C, C++ and the linker,
`CMAKE_PROJECT_INCLUDE=native/speech/compat/mingw_lib_prefix.cmake` and the forced include
`native/speech/compat/mingw_compat.h`, and link libstdc++, libgcc and winpthreads statically, so
the exes need only system DLLs. Each takes about a minute from clean; `cargo` caches the rest.

Tests and checks:

```bash
(cd native/speech && cargo test && cargo clippy --all-targets -- -D warnings)
npm run build:speech-host && npm run fetch:test-speech && npm run test:native
scripts/smoke-speech-wine.sh   # both Windows exes under wine: imports, cpu, vad, transcribe, cancel
SSW_SPEECH_CLIP=clip.wav scripts/smoke-speech-wine.sh   # ... and their speed on a longer WAV
npm run notices -- --check
```

`npm run fetch:test-speech` downloads the catalog's `whisper-tiny` from its pinned Hugging Face
address into `.cache/test-speech/` (`SSW_TEST_SPEECH_CACHE` overrides) and checks its SHA-256; the
speech detector model and the speech fixtures are committed. The word-timing benchmark
(`native/speech/bench/eval_stream.py`, base q5_1 on the 105.7 s LibriSpeech clip from
`bench/fetch_speech.py`) is manual. CI caches `~/.cargo`, `native/speech/target` and
`.cache/test-speech`.

`THIRD_PARTY_NOTICES.txt` is generated by `npm run notices` from `resources/notices/*.txt`
(hand-written: whisper.cpp and ggml, Silero VAD, the Whisper weights, the MinGW-w64 and GCC
runtimes, the Rust standard library, FFmpeg, Chromium, MediaPipe), `cargo metadata` of both crates
(normal dependencies for x86_64-pc-windows-gnu) and the npm packages that ship or are bundled;
commit it after a dependency change. Without `cargo` it keeps the committed Rust crates' section
(with a warning), so npm and hand-written changes can be regenerated without Rust.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `predist: ERROR: could not get the Windows ffmpeg.exe` | network/proxy problem; see "Cross-building" for the manual download or `FFMPEG_BINARIES_URL` |
| `Code signing is misconfigured` | the message names the missing or conflicting variables; set those of exactly one method |
| `osslsigncode ... libcrypto.so.1.1` (Linux) | install `osslsigncode` and set `USE_SYSTEM_SIGNCODE=true` |
| `Running as root without --no-sandbox is not supported` | `npm run icons` already passes `--no-sandbox`; add it when you start Electron yourself as root |
| `verify-dist: FAIL app.asar contains files that must not ship` | something bypassed `electron-builder.config.cjs`; build with `npm run dist:win` |
| SmartScreen warning after installing | the build is unsigned, see "Code signing" |
| `build-native: the POSIX-thread MinGW ... is missing` | `apt install mingw-w64` (the `-posix` compilers come with it); the win32-thread GCC fails with `__mingwthr_key_dtor` |
| `build-native: libclang is missing` | `apt install clang libclang-dev`, or set `LIBCLANG_PATH` to the folder holding `libclang.so` |
| `predist: ERROR: resources/THIRD_PARTY_NOTICES.txt is not up to date` | run `npm run notices` and commit the file |
| `smoke-speech-wine.sh` cannot open a non-ASCII path | it sets `LANG=C.UTF-8`; wine mangles paths under a non-UTF-8 locale |
