# Auto-update and a refreshable model list (NW-15)

Status: design for Flown 0.7.1, on `ccr-b6df7cf7-yked87` after 0.7.0 (commit 1f47d5b).

Flown 0.7.0 and earlier reach users only as an installer file passed around by hand. This adds:

1. **Updates in the app**: Flown looks for a newer version on GitHub, downloads it in the
   background and installs it when the user quits Flown or presses *Restart now*.
2. **A release workflow** that builds the installer on GitHub and puts it, with the update
   metadata, in a *draft* release. Nothing reaches users until a person presses *Publish*.
3. **A refreshable list of suggested AI models**, so a retired model (OpenAI removes `whisper-1`
   on 26 February 2027, see ROADMAP.md) can be flagged and the suggestions changed without a new
   release.

Users of 0.7.0 have no updater: they install 0.7.1 by hand once; every later version arrives by
itself.

## 1. Decisions

### 1.1 Where updates come from: GitHub Releases of this repository

The repository `samiulakhan12/windows-screen-studio` is public, so its Releases serve files to
anyone over HTTPS with no key and no cost, and electron-updater has a GitHub provider for them.

- Alternatives: a static host or object storage (another account, another bill, another secret to
  keep), or our own server (the same, plus uptime). GitHub is where the code already lives.
- The provider is fixed at build time (`app-update.yml` inside the app, written by
  electron-builder from `publish` in `electron-builder.config.cjs`); nothing at run time can point
  Flown at another feed.
- Only full releases count: drafts and pre-releases are never offered (`allowPrerelease: false`).

### 1.2 The updater: electron-updater 6.8.10

electron-updater is electron-builder's own updater: it reads `latest.yml`, downloads the
installer, checks its SHA-512 against `latest.yml`, and runs the NSIS installer silently
(`/S --updated`) after the app quits. Version **6.8.10** (26 September 2026) uses
`builder-util-runtime` 9.7.0, the same as the installed electron-builder 26.15.3 (and 6.8.10 is
over a month old, the newer 6.8.11/6.8.12 are not). It is the one new dependency, pinned exactly.

- Alternative: our own download-verify-run code. It would repeat what electron-updater does
  (resumable download, hash check, elevation for per-machine installs, running the installer at
  quit), with more room for mistakes.

### 1.3 Integrity, and what it does not cover

- HTTPS to github.com and its download host only; electron-updater refuses a download whose
  SHA-512 differs from `latest.yml`.
- No downgrades (`allowDowngrade: false`): a release with a lower version is never installed.
- When an Authenticode certificate is configured (`scripts/lib/signing.cjs`, `docs/BUILDING.md`),
  `win.publisherName` is set too, so electron-updater also checks that a downloaded installer is
  signed by the same publisher. Builds are unsigned today, so that check is off.
- **What this does not cover:** with unsigned builds, whoever controls the GitHub account can ship
  an update to every user. The account must have two-factor sign-in; signing (above) closes the
  gap. Stated in `docs/RELEASING.md` and the release notes.

### 1.4 A person publishes every release (and how to roll back)

The workflow (§4) makes a **draft** release. Drafts are invisible to the app. The owner opens the
draft, can download and try its installer, and presses *Publish release*; from then on running
copies find it within four hours.

A bad release is stopped by turning it back into a draft (or deleting it): copies that have not
downloaded it yet stop being offered it. Copies that already installed it get the fix as the next
version; Flown never installs a lower version. Older installers stay on the Releases page for a
manual reinstall.

### 1.5 When Flown checks, downloads and installs

| Step | When | Notes |
|---|---|---|
| Check | 30 s after start, then every 4 h, and on *Check for updates* | Packaged Windows builds only; never in development or tests (a fake updater, §6). |
| Download | at once when an update is found and *Update Flown automatically* is on; otherwise on *Download* | One at a time; progress shown in Settings. |
| Install | when Flown quits (`autoInstallOnAppQuit`), or on *Restart now* | *Restart now* is refused while anything is running: a recording, an export, captions or analysis, an import, Clean voice, or a copy being made. The button says why. |

The four-hour period and the 30 s delay keep start-up quick and the number of requests small
(electron-updater reads the repository's public releases feed and `latest.yml` from github.com,
not the rate-limited API; one check is two small requests). A failed check is retried at the next
period; the error shows in Settings only.

Quitting with an update downloaded installs it silently and does not reopen Flown. *Restart now*
installs and reopens it. A per-machine install (Program Files) shows Windows' permission prompt
for the installer, as a first install does.

### 1.6 Settings: one switch

`userData/updates.json` (version 1): `{ "auto": true, "lastCheck": "<ISO time>" | null }`. A
missing or unreadable file means the defaults; changes are written atomically
(`writeFileAtomicSync`). The settings of 0.7.0 are untouched (no existing file changes).

*Update Flown automatically* (on by default) covers the automatic checks, the automatic download
and the model-list refresh (§3). Off: Flown makes no request to GitHub on its own; *Check for
updates* still works when pressed.

### 1.7 What the user sees

Settings › About, under the version (a status line and buttons; `aria-live="polite"` on the
status):

- "Flown is up to date." (with "Last checked 10:42")
- "Checking for updates…"
- "Flown 0.7.2 is available." [Download] (when automatic updates are off)
- "Downloading Flown 0.7.2… 45%"
- "Flown 0.7.2 is ready. It installs when you close Flown." [Restart now]
- "Couldn't check for updates. Check your internet connection and try again." [Check for updates]
- In development: "Updates are turned off in this build."

Plus: [Check for updates], the switch "Update Flown automatically", and "What's new in 0.7.2", a
disclosure with the release notes as plain text (HTML tags removed, at most 4000 characters; the
release body is untrusted text and is never rendered as HTML).

Home, when an update is ready: a notice "Flown 0.7.2 is ready. It installs when you close Flown."
with [Restart now] and [Later] (Later hides it until the next version or the next start). Never
in the editor or during a recording: updates must not interrupt work.

*Restart now* while something runs: main refuses it and the reason shows where the button is, for
example "Finish or stop the export first." (main checks when it is pressed; nothing installs). The
Settings action is one button whose label follows the state (Check for updates, Download, Restart
now); while it waits it is `aria-disabled`, not removed or disabled, so the keyboard focus stays.

## 2. Main process

- `src/main/updates/updateService.ts`: `UpdateService` owns the state (`UpdateState`, §5), the
  schedule and the prefs, and talks to the updater through a port, so tests drive it with a fake:

  ```ts
  interface UpdaterPort {
    check(): Promise<void>            // emits 'available' | 'none' | 'error'
    download(): Promise<void>         // emits 'progress' then 'downloaded' | 'error'
    install(): void                   // quits and installs (restart after)
    on(listener: (e: UpdaterEvent) => void): () => void
  }
  ```

- `src/main/updates/electronUpdaterPort.ts`: the real port over `autoUpdater` from
  electron-updater (`autoDownload = false`, `autoInstallOnAppQuit = true`,
  `allowPrerelease = false`, `allowDowngrade = false`, logger to `appLog`).
- `src/main/updates/fakeUpdaterPort.ts`: for development and the e2e tests, enabled only when the
  app is not packaged and `SSW_UPDATES_FAKE` names a scenario (`available`, `none`, `error`); its
  install writes a line to `SSW_UPDATES_FAKE_LOG` and quits.
- `src/main/updates/updatePrefs.ts`: `userData/updates.json` as in §1.6.
- `src/main/updates/updatesIpc.ts`: `updates:get`, `updates:check`, `updates:download`,
  `updates:install`, `updates:setAuto` (main window's app page only, the sender check every
  handler uses) and the event `updates:changed` to every window.
- Busy check (`busyReason()`): `jobsSnapshot()` (exports, captions, analysis), plus small read-only
  getters added to the features that own the state: `exportRunning()` (exportIpc),
  `importRunning()` (importVideo), `voiceCleaner.busy` (voice), `copyRunning()` (projectsIpc). A
  recording keeps Home hidden, so *Restart now* cannot be pressed during one; quitting during a
  recording already waits for the capture helper (nativeCapture's will-quit guard) and the
  installer runs only after the app has really quit.

## 3. The refreshable model list

- `resources/ai-models.json` in the repository is the list (version 1):

  ```json
  {
    "version": 1,
    "updated": "2026-10-30",
    "providers": {
      "openai": { "model": "gpt-6.1-sol", "transcriptionModel": "whisper-1" },
      "gemini": { "model": "gemini-3.8-flash", "transcriptionModel": "gemini-3.8-flash" },
      "anthropic": { "model": "claude-opus-5-5" }
    },
    "retiring": [{ "provider": "openai", "model": "whisper-1", "on": "2027-02-26" }]
  }
  ```

- The app bundles it (imported at build time) and refreshes it from
  `https://raw.githubusercontent.com/samiulakhan12/windows-screen-studio/HEAD/resources/ai-models.json`
  (the default branch) with the update check, at most once a day, when automatic updates are on.
  Changing the suggestions is a commit to that file; no release needed.
- Strictly checked (`src/shared/ai/modelList.ts`): at most 64 KB, provider kinds Flown knows,
  model names of 1-100 characters from `[A-Za-z0-9._:/-]`, transcription models only for
  providers that transcribe, dates as `YYYY-MM-DD`, at most 50 retiring entries. Anything else and
  the whole download is ignored (the bundled or cached list stays). The newest valid list by
  `updated` wins, so an old cache never replaces a newer bundled list.
- Every installed version reads the same file, so a provider entry can carry `"minApp": "x.y.z"`
  (a version like the app's own; anything else and the download is ignored): a version older than
  that keeps the bundled suggestion for that provider and takes the rest of the list. A suggestion
  that needs new code (a transcription model without word times, say) is then given only to
  versions that have that code.
- Cached in `userData/ai-models.json` (written atomically) as downloaded, with `minApp` kept, so a
  copy updated to a newer version reads its gated suggestions again from the cache.
- What it changes, and only this: the suggested models when adding a provider (Settings › AI), the
  transcription model of a provider that has none of its own, and a note in Settings › AI next to
  a provider whose model is on the retiring list: "OpenAI retires whisper-1 on 26 February 2027.
  Choose another transcription model before then." It never changes a model the user saved, never
  adds a provider, host or address, and nothing in it runs.

## 4. Releasing

- `.github/workflows/release.yml`: run by hand (*Actions › Release › Run workflow*) on the default
  branch. Ubuntu 24.04, the toolchain `native/README.md` lists (Rust with
  `x86_64-pc-windows-gnu`, MinGW-w64 posix, cmake, libclang, Wine), `npm ci`, then
  `SSW_REQUIRE_NATIVE=1 npm run dist:win` (predist and verify-dist included). It takes the notes
  from the `## <version>` section of `docs/RELEASE-NOTES.md` (`scripts/release-notes.mjs`) and runs
  `gh release create v<version> --draft` with `Flown-Setup-<version>.exe` and `latest.yml` (no
  blockmap: differential downloads are off, `nsis.differentialPackage`). It stops before building when the tag exists or the notes section is missing.
- `docs/RELEASING.md`: bump the version and the notes, push, run the workflow, try the draft,
  press *Publish release*; how to pull a bad release; why two-factor sign-in matters.
- `verify-dist` now also checks that `latest.yml` names the installer with its size and SHA-512 and
  that `resources/app-update.yml` points at this repository's GitHub releases.

## 5. Shared state (pure, tested)

`src/shared/updates/updates.ts`:

```ts
type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
interface UpdateState {
  phase: UpdatePhase
  current: string                 // this version
  version?: string                // the newer version found
  notes?: string                  // plain text, ≤ 4000 characters
  percent?: number                // downloading, 0-100
  error?: string                  // plain copy for the user
  lastCheck: string | null
  auto: boolean
  busy?: string                   // why Restart now cannot run now
}
```

Plus `reduce(state, event)`, `notesText(raw)` (tags removed, entities decoded, whitespace folded,
capped), `statusLine(state, now)` and `isNewer(a, b)` (semver, no pre-releases).

## 6. Tests

- Unit: the reducer and status copy; `notesText` (tags, scripts, entities, length); the schedule
  (first check at 30 s, then 4 h, none when off, none while one runs); prefs (defaults, bad files,
  atomic write); the busy check; `UpdateService` with a fake port (auto on and off, download
  errors, install refused while busy); the model list (every rule of §3, newest wins, cache);
  `release-notes.mjs` (section found, missing, last section); the builder config (`publish`
  points at this repository, `publisherName` only when signing); verify-dist's new checks.
- E2E `tests/e2e/auto-update.e2e.cjs` with the fake updater: Settings › About shows each state;
  *Download* and the progress; the Home notice and *Later*; *Restart now* refused during an export
  job and accepted after (the fake logs the install and the app quits); *Update Flown
  automatically* off survives a restart; the AI settings note for a retiring model.
- On a Windows PC (cannot run here): install 0.7.1, publish 0.7.2, see Flown download it and
  install on quit; the per-machine install's permission prompt.

## 7. Left for later

Differential downloads (blockmaps of both versions), a beta channel, staged roll-outs, signing
(needs a certificate), an update check from the command line.
