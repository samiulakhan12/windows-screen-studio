# Share without a server (F-22)

Status: built for the next release (branch `feat-share`).

After an export, Flown puts the video where people need it, without any Flown server:

* **Cloud folders.** Flown finds the user's OneDrive, Dropbox and Google Drive folders on this PC
  (the places their apps report, and the usual places, always shown with where they came from),
  and copies the exported file into a `Flown` folder inside, with progress and Cancel ("Saved to
  OneDrive › Flown"). Any other folder can be added by hand (a network share, Box, iCloud Drive).
  The cloud app then uploads it, as it does for every file in that folder.
* **Post to a chat.** A Slack, Discord or Microsoft Teams *incoming webhook* the user pastes in
  Settings › Share (stored encrypted, like AI keys) gets a short message: the title, the length and,
  when the file went to a cloud folder, where (and the link, when one is known). **The video is
  never uploaded to a webhook.**
* **After export.** The export dialog has an "After export" row next to "Also save": chips such as
  "Copy to OneDrive" and "Post to #team", remembered **per destination preset**. The done view shows
  each step's progress, with Cancel, and offers the steps not chosen; the "Export finished"
  notification offers them as buttons too.

Nothing here changes `project.json`: old projects load byte for byte as before. New state lives in
`userData/share.json` (main) and the export dialog's localStorage (`export-share`).

---

## 1. What the code does today (read before deciding)

* **Exports are driven by the page** (`src/renderer/src/editor/exporter.ts`) and written by main
  (`src/main/exportIpc.ts`) to a hidden `.<name>.partial-*` file renamed into place on success
  (`exportJob.ts` `partialPath`, `moveIntoPlace`). Main remembers every file exported in this
  session (`exportIpc.ts` `exportedFiles`, `isExportedFile`): the clipboard copy, the export bundle
  (`exportBundle.ts`) and the notifications only ever act on those. Share does the same.
* **Export file names** are checked by `exportJob.ts` `batchFileOk` (no folders, no reserved
  characters, no leading dot, no trailing dot or space, a known extension, ≤ 200 characters); a free
  name is found with `freeBatchPath` (" (2)", " (3)": a file is never replaced).
* **The "Also save" row** (`ExportBundleOptions.tsx`) is remembered globally in localStorage
  (`export-bundle`); the export dialog's settings are under `export-settings`. A finished single
  export calls `writeBundle` (`exportBundleRun.ts`) then `link.end({ kind: 'done', files })`
  (`useLongJob`), then shows the done view (`ExportDialog.tsx` `phase.kind === 'done'`).
* **Notifications** (`src/main/longJobs.ts` `endJob` → `TaskbarPort.notify`, made in
  `longJobsPort.ts`) show "Export finished" with **Open** and **Show in folder** only when Flown's
  window is not focused. Buttons are `NotificationConstructorOptions.actions` (Windows: up to 5).
* **AI keys** (`src/main/ai/keyStore.ts`) are encrypted with `safeStorage` (DPAPI on Windows) via a
  `SecretBox` seam; when encryption is unavailable (or the Linux `basic_text` fallback in a packaged
  app) **no key is stored**. The page only ever sees a masked key. Share's webhook URLs reuse that
  `SecretBox` and the same rule.
* **Network** is main-only: the page's CSP allows no requests (`src/main/security.ts`). The AI
  clients use Node's fetch with time limits (`ai/request.ts`).
* **The log** (`src/main/appLog.ts`) redacts every line with `src/shared/diagnostics/redact.ts`
  (keys, tokens, paths, e-mail addresses). A Slack webhook's secret part (24 characters) is shorter
  than its "long run" rule (32+), so a logged Slack URL would keep its secret: §6 adds a rule.
* **Test seams** follow one pattern: an environment variable read only by an unpackaged app
  (`ai/endpoints.ts` `SSW_AI_BASE_URL_*`, `updatesIpc.ts` `SSW_UPDATES_FAKE`).

## 2. Decisions

### 2.1 How to reach the cloud — **the cloud app's own folder**
* *Chosen:* copy into the folder the OneDrive / Dropbox / Google Drive desktop app syncs. No account,
  no OAuth, no API key, no server; the user's cloud app does the upload, with its own retry, pause
  and metered-network rules; it works offline (it uploads later).
* *Rejected:* the services' web APIs (Microsoft Graph, Dropbox API, Drive API): each needs a
  registered app with a client id and an OAuth flow per service, tokens to refresh and store, and
  upload code for files of several GB. Much more surface for the same result.
* *Rejected for now:* the user's `rclone` (the roadmap's first sketch): it means finding and running
  an outside program with arguments built from user data, and parsing its output. Left for later
  (§11) behind the same "destination" model.

### 2.2 Finding the folders — **what the apps report, then the usual places; always shown**
Each candidate carries its **source**, shown in Settings and in the chip's tooltip, and is kept only
when it exists and is a folder. Duplicates (same path, any case and separators) are merged, the
better source winning. On Windows only (§2.9 for the test seam):

| Service | Source (in order) | Label |
|---|---|---|
| OneDrive personal | `HKCU\Software\Microsoft\OneDrive\Accounts\Personal` `UserFolder`; env `OneDriveConsumer` | "OneDrive" |
| OneDrive work or school | `HKCU\Software\Microsoft\OneDrive\Accounts\Business1`…`Business9` `UserFolder` (`DisplayName` → "OneDrive – Contoso"); env `OneDriveCommercial` | "OneDrive – <org>" |
| OneDrive (either) | env `OneDrive` when it matches none of the above | "OneDrive" |
| Dropbox | `%APPDATA%\Dropbox\info.json`, then `%LOCALAPPDATA%\Dropbox\info.json`: `personal.path`, `business.path` (file ≤ 64 KB, JSON) | "Dropbox", "Dropbox (work)" |
| Dropbox | usual place `%USERPROFILE%\Dropbox` | "Dropbox" |
| Google Drive | `HKCU\Software\Google\DriveFS` `PerAccountPreferences` (JSON; every `mount_point_path`, a letter or a path) and `DefaultMountPoint` → `<mount>\My Drive` | "Google Drive" |
| Google Drive | usual places `G:\My Drive` (stream mode), `%USERPROFILE%\My Drive` (mirror mode), `%USERPROFILE%\Google Drive` (the old Backup and Sync) | "Google Drive" |

Sources shown: "Found in OneDrive's settings", "Found in Dropbox's settings", "Found in Google
Drive's settings", "Found at the usual place", "Added by you". **Nothing is guessed silently**:
every folder Flown would copy into is listed in Settings › Share with its full path and its source,
can be turned off there ("Use" switch), and the export chip's tooltip shows the full path.

* Registry values are read with `%SystemRoot%\System32\reg.exe query <key> [/s]`: a fixed program
  path, fixed arguments (two keys, never built from user data), `windowsHide`, a **5 s** time limit,
  **256 KB** output cap. *Rejected:* a native registry module (a new dependency and a native build
  for two reads). Its output is parsed by a pure function (`parseRegQuery`).
* Detection runs when Settings › Share or the export dialog opens (cached for **60 s**, "Look again"
  forces it). It never throws: a source that fails is skipped.
* A localised Google Drive ("Meine Ablage") is not found automatically: "Add a folder…" covers it
  (§11).

### 2.3 Copying — **a hidden partial file, renamed; never replaces; never leaves the folder**
* Target folder `<root>\Flown`, created when missing. The file keeps its exported name; when taken,
  `freeBatchPath` adds " (2)" (a share never replaces a file).
* Bytes go to `partialPath(target)` (hidden `.name.partial-…`) with a stream copy (1 MiB chunks),
  then `moveIntoPlace`. Cancel or failure deletes the partial file (`removeWithRetries`). The cloud
  app therefore never uploads half a video (OneDrive and Dropbox skip neither hidden nor partial
  files, but a partial file lives seconds and is replaced by the rename; the final file appears
  complete in one step).
* Before copying: free space at the target (`fs.statfs`) must be ≥ size + **64 MB**, else
  "There is not enough space on the drive of OneDrive (needs 1.2 GB)."
* **Containment:** the real path (`fs.realpath`) of `<root>\Flown` must be `<real root>` + `\Flown`
  (a junction or link named `Flown` that points elsewhere is refused). The root itself must be a
  folder Flown found this session or one the user picked (stored in `share.json`); the page only
  ever sends a destination **id**, never a path.
* The source must be a file exported in this session (`isExportedFile`), with a name `batchFileOk`
  accepts. When the file is already inside `<root>\Flown` (the user exported straight into it), the
  step is done at once: "Already in OneDrive › Flown".
* Progress: bytes copied / size, sent at most every **200 ms**.

### 2.4 Share links — **only when the cloud app offers one locally; otherwise say how**
None of the three desktop apps offers a documented local way to make a share link (no CLI, no local
API; their "Copy link" lives in Explorer's right-click menu, a shell extension). So today Flown never
invents a link. After a copy the done view says how: **"To share a link, right-click the file and
choose Share (OneDrive), Copy Dropbox link (Dropbox) or Share › Copy link (Google Drive)."** with a
**Show in folder** button that selects the copied file. The model keeps an optional `link` per copy
(a `LinkProvider` seam that returns `null` for every service today) so a future source (rclone,
§11) fills it and the chat message then carries it.

### 2.5 Chats — **incoming webhooks only, a strict host list, a short text**
* Accepted URLs (checked when saved **and** before every post):
  * `https://hooks.slack.com/services/…` (Slack),
  * `https://discord.com/api/webhooks/<id>/<token>`, also `discordapp.com`, `ptb.discord.com`,
    `canary.discord.com` (Discord's own hosts),
  * `https://<tenant>.webhook.office.com/webhookb2/…` (Microsoft Teams incoming webhook).
  HTTPS only, default port only, no user name or password in the URL, no fragment, ≤ **1024**
  characters, printable ASCII only. Anything else: "Paste an incoming webhook from Slack, Discord or
  Microsoft Teams (it starts with https://hooks.slack.com/, https://discord.com/api/webhooks/ or
  https://….webhook.office.com/)."
* *Rejected:* any HTTPS host (n8n, Zapier, a self-hosted relay): a pasted URL is then a way to send
  data anywhere, and the message would go to services the user cannot see in the UI. Teams'
  newer "Workflows" webhooks (`*.logic.azure.com`) are left for later (§11): the host is shared by
  every Azure Logic App.
* **Message** (pure, `shareMessage`): title (whitespace collapsed, control characters removed, ≤
  **120** characters with "…"), length as `m:ss` / `h:mm:ss`, then the place:
  ```
  New video: Product demo (2:31)
  Saved to OneDrive › Flown
  ```
  or `Link: https://…` when a link is known. **Never** a local path (it holds the user name) and
  never the file itself. Per service: Slack `{ "text" }` with `& < >` escaped (so `<!channel>` cannot
  be written); Discord `{ "content", "allowed_mentions": { "parse": [] } }` (no `@everyone` ping)
  with markdown escaped; Teams `{ "text" }` with `< > * _ \` escaped. Body ≤ **4 KB**.
* **Request:** `POST`, `content-type: application/json`, **15 s** time limit, **no redirects**
  (`redirect: 'error'`: a redirect could leave the allowed host), response read up to **16 KB** and
  never shown. Electron's `net.fetch` (uses the system proxy). No retries: the done view has "Try
  again".
* **Errors** (never with the URL): 404 / 410 "This webhook no longer exists. Paste a new one in
  Settings › Share."; 401 / 403 "Slack refused the message: the webhook may have been turned off.";
  429 "Slack is busy. Try again in a minute."; other 4xx "Slack did not accept the message (400).";
  5xx "Slack had a problem (502). Try again later."; time limit "Slack did not answer in 15 s.";
  network "Could not reach Slack. Check the connection."
* **Test** in Settings posts "Flown is connected. Videos you share will be posted here."

### 2.6 Storage — **userData/share.json, URLs encrypted like AI keys**
```jsonc
{ "version": 1,
  "folders": [ { "id": "cf1a2b3c4d", "path": "D:\\Team share", "label": "Team share", "addedAt": "…" } ],
  "off": [ "cf9f8e7d6c" ],                 // found folders the user turned off
  "hooks": [ { "id": "whk…", "service": "slack", "label": "#demos", "url": "<base64 safeStorage>", "createdAt": "…" } ] }
```
* A found folder's id is `cf` + the first 10 hex characters of SHA-256 of its normalised path
  (lower case, `\` separators, no trailing separator), so a chosen chip survives restarts and a
  folder found again keeps its choice. Picked folders use the same id.
* Each entry is checked when read (bad ones dropped with a warning that names no path or URL); a
  missing or unreadable file means none. Writes are atomic (`writeFileAtomicSync`). At most **8**
  picked folders and **10** chats; labels ≤ **60** characters.
* The page sees `ShareTargets`: folders `{ id, service, label, path, source, on }` (the path is the
  user's own and is shown) and chats `{ id, service, label, masked }`, `masked` being
  `hooks.slack.com/…/AbCd` (host and the last 4 characters).
* No encryption: no chat is saved ("Webhooks cannot be stored safely on this PC (…), so it was not
  saved."), exactly as AI keys.

### 2.7 After export — **per preset, in the export dialog; offered afterwards**
* **Remembered per destination preset**: localStorage `export-share` =
  `{ "v": 1, "byPreset": { "youtube": ["cf…", "whk…"], "custom": [] } }`; the key is the selected
  preset id, `custom` when none. Ids no longer offered are ignored when read (and dropped when
  next written); at most **12** ids per preset, **50** presets. Unknown shapes read as empty.
* The row "After export" sits right after "Also save" (and its Chapters row) in the export settings,
  only for a **single** export (not batch, not one file per chapter, whose many files would flood a
  chat): there the row says "After export works when one file is exported." Chips: "Copy to
  OneDrive", "Copy to Dropbox", "Copy to Team share", "Post to #demos" (`aria-pressed`, a tooltip
  with the path or the masked URL). With nothing set up: "Add a cloud folder or a chat in Settings
  › Share."
* **Order:** copies first (one at a time), then posts, so a post can say where the file went.
* **The done view** shows a "Share" block: one line per step with its state ("Copying to OneDrive…
  42%", "Saved to OneDrive › Flown", "Posted to #demos", "Could not post to #demos: …"), **Cancel**
  while running, **Try again** on a failed step, **Show in folder** on a saved copy, the link hint
  (§2.4), and buttons for the destinations not chosen ("Copy to Dropbox", "Post to #demos").
  Progress is announced politely (`role="status"`), at most each 10 %.
* **The notification:** when the window is in the background, "Export finished" gets one button per
  destination not already running ("Copy to OneDrive", "Post to #demos"), after Open and Show in
  folder, **at most 3** (Windows shows 5 buttons). A click runs that step in main; when it ends with
  the window still in the background a second notification says "Saved to OneDrive › Flown" /
  "Posted to #demos" (or "Could not share" and the reason), with **Show in folder** for a copy.
* A post after a copy (in the same run, or later for the same file in this session) uses that copy's
  place; main remembers the last place per exported file for the session.

### 2.8 Where it runs — **main owns the runs, the page watches**
* `shareStart(file, targetIds, meta)` validates and starts a **run** (steps in order) in main and
  returns its view; `share:update` events carry `ShareRunView` to the app's window; `shareCancel(runId)`
  stops it. The notification buttons start runs the same way, so both paths share one code path.
* `meta` = `{ title, seconds }` from the page (checked: text ≤ 200, 0 ≤ seconds ≤ 24 h). For the
  notification buttons, the page registers it with the file when the export ends (`shareOffer`, the
  line before `link.end`), with `auto: true` when it starts a run itself (no buttons then).
* At most **4** runs at once ("Wait for the other shares to finish."); a run for a file that is
  already copying to the same place is refused.
* *Rejected:* copying from the page (no file access in the sandboxed page) and posting from the page
  (its CSP blocks the network on purpose).

### 2.9 Test seams
* `SSW_SHARE_FAKE_CLOUD=<json file>` (unpackaged only): `{ "env": { … }, "registry": { "<key>": "<reg
  query output>" } }` replaces the environment and `reg.exe` for detection, on any OS, so the
  end-to-end test runs the real detection code on Linux with Windows-shaped data.
* `SSW_SHARE_WEBHOOK_ORIGIN=http://127.0.0.1:<port>` (unpackaged only): a post that passed the real
  URL checks is sent to that origin with the same path, so a local mock server sees exactly what
  Slack would. A packaged app ignores both.

## 3. Data model and old projects / settings
* `project.json`: **unchanged**. No migration.
* App settings, AI providers, the export dialog's existing keys: unchanged. `share.json` and
  `export-share` are new; their absence means "nothing set up".
* The notification change is additive (§7): with no share provider registered, notifications are
  exactly as before.

## 4. UI and copy

**Settings › Share** (a new section after Brand kit):

> **Share**
> Copy exports to your cloud folders and tell your team in a chat. Nothing goes through a Flown server.
>
> **Cloud folders** — OneDrive · `C:\Users\…\OneDrive` · Found in OneDrive's settings · [x] Use
> "+ Add a folder…" · "Look again"
> Empty: "No OneDrive, Dropbox or Google Drive folder was found on this PC. Add any folder instead."
> Under the list: "Videos go into a Flown folder inside. Your cloud app uploads them."
>
> **Chats** — #demos · Slack · `hooks.slack.com/…/AbCd` · [Test] [Remove]
> "+ Add a chat" → Name, Webhook URL (hidden like a key, Show / Hide), hint: "Paste an incoming
> webhook from Slack, Discord or Microsoft Teams. Flown posts the title, the length and where the
> video was saved. The video itself is never uploaded." "It is encrypted on this PC."
> Empty: "No chat yet."

**Export dialog**: row "After export" (chips, §2.7). **Done view**: "Share" block (§2.7).

Keyboard: chips and buttons are native buttons; the add-chat form traps nothing (it lives inside the
Settings dialog, which does); after Save / Cancel / Remove focus returns to "+ Add a chat" (as the AI
providers do). Contrast: text uses `--text-1/2/3`, success and danger use `--success-text` /
`--danger-text` on `--surface-2` (≥ 4.5:1, as the existing notices).

## 5. Security
* The page sends ids, never paths or URLs to act on (except the URL typed when adding a chat, which
  is validated and encrypted at once). Destinations are only folders found this session or picked
  with the system folder dialog (`share:pickFolder`, main's own dialog).
* Only exported files of this session are copied; names checked with `batchFileOk`; the target is
  built by main; containment checked on real paths; never replaces; partial file deleted on any
  failure.
* `reg.exe` with a fixed absolute path and fixed arguments, a time limit and an output cap; its
  output is parsed, never executed; a path from it or from `info.json` is used only after it is an
  absolute, existing folder.
* Webhooks: strict hosts, HTTPS, no redirects, size and time caps, response never shown; the URL is
  encrypted at rest, never sent to the page, never logged; error messages name the service, never
  the URL. A new redaction rule (§6) covers any URL that would still reach the log.
* Every IPC handler checks the sender is the app's page (`isAppUrl`), as `aiIpc.ts` does.
* Diagnostics: share adds nothing to the diagnostics report.

## 6. The log
`src/shared/diagnostics/redact.ts` gets one rule (additive): the secret part of a Slack, Discord or
Teams webhook URL becomes `<secret>` (`hooks.slack.com/services/<secret>`,
`discord.com/api/webhooks/<secret>`, `webhook.office.com/webhookb2/<secret>`). Share itself logs
only "Share: copied 1 file to onedrive (24.1 MB)" / "Share: post to slack failed (404)".

## 7. Files and exported signatures
New, owned by this feature:
* `src/shared/share/webhooks.ts` — `WEBHOOK_SERVICES`, `parseWebhookUrl(raw): { service, url }`
  (throws a message), `maskWebhook(url)`, `shareMessage(meta, place)`, `webhookBody(service, text)`,
  `postFailure(service, status | 'timeout' | 'network')`, `SHARE_LIMITS`.
* `src/shared/share/cloudFolders.ts` — `parseRegQuery(stdout)`, `cloudCandidates(input)`,
  `folderId(path)`, `normalizeFolderPath`, `placeText(label)`, `SOURCE_TEXT`.
* `src/shared/share/choices.ts` — `readShareChoices(raw)`, `choicesFor(map, presetId, valid)`,
  `withChoices(map, presetId, ids)`.
* `src/shared/share/runs.ts` — `ShareRunView`, `ShareStepView`, step text (`stepText`), `linkHint`.
* `src/shared/api/share.ts` — `ShareApi`, `ShareTargets`, `ShareMeta`.
* `src/main/share/shareStore.ts` — `ShareStore` (folders, off list, chats; encrypt / decrypt).
* `src/main/share/cloudDetect.ts` — `CloudProbe`, `realProbe()`, `fakeProbe(file)`, `detectCloudFolders(probe)`.
* `src/main/share/copyToFolder.ts` — `copyIntoFolder(file, root, opts)`.
* `src/main/share/webhookPost.ts` — `PostPort`, `postToWebhook(port, url, body, signal)`.
* `src/main/share/shareService.ts` — runs: start, cancel, views, the notification extras.
* `src/main/share/shareIpc.ts` — `registerShareIpc()`.
* `src/preload/share.ts`; `src/renderer/src/share/ShareSection.tsx`, `ShareAfterExport.tsx`,
  `ShareDone.tsx`, `useShare.ts`, `share.css`.

Additive lines in shared files: `src/main/index.ts` (register), `src/preload/index.ts`,
`src/shared/api.ts` (the type), `SettingsDialog.tsx` (import + one line), `ExportDialog.tsx` (the
row, the run start and the done block), `src/shared/diagnostics/redact.ts` (§6), and two small
seams for the notification buttons (unavoidable: the notification is built there):
`src/main/longJobs.ts` (`setNotificationExtras`, a few lines in `endJob`) and `longJobsPort.ts`
(extra buttons after Open / Show in folder). No new dependency.

## 8. Risks
* **Detection paths on real Windows** (registry layout of OneDrive business accounts, Google
  Drive's `PerAccountPreferences` shape) are from the apps' documented / observed behaviour and
  need a real PC to confirm (BUILD-REPORT). Mitigation: every source is optional, and "Add a
  folder…" always works.
* **Files On-Demand**: copying into OneDrive / Google Drive stream mode writes through their file
  system filter; large files may be slower than a local copy. Progress and Cancel cover it.
* **Teams connectors** are being retired by Microsoft in favour of Workflows; the error for a 404 /
  410 says what to do.

## 9. Test plan
Unit (vitest, each failing without its code):
* `shareWebhooks.test.ts` — accepted / refused URLs (http, other hosts, look-alike hosts such as
  `hooks.slack.com.evil.io`, ports, credentials, fragments, length), masking, message text (title
  clipping, control characters, length format, place / link), per-service bodies and escaping
  (`<!channel>`, `@everyone`), failure messages without URL.
* `shareCloud.test.ts` — `parseRegQuery` on real-shaped output (spaces in paths, several keys),
  candidates from registry / env / info.json / DriveFS JSON, de-duplication and source order, ids.
* `shareChoices.test.ts` — per-preset read / write, unknown ids dropped, caps, bad shapes.
* `shareStore.test.ts` — encrypted at rest, masked to the page, refuses to save without encryption,
  malformed entries dropped, limits, found folders turned off.
* `shareCopy.test.ts` — copies with progress, never replaces, " (2)", cancel deletes the partial
  file, refuses a non-exported file, a bad name, a junction escape, low disk space; already there.
* `sharePost.test.ts` — no redirect, time limit, response cap, status → message, re-validation
  before posting, test-origin rewrite only when allowed.
* `shareService.test.ts` — copy then post with the place, cancel, notification extras (none when
  auto, at most 3), the run cap.
* `redact.test` addition — webhook URLs redacted.

End-to-end (`tests/e2e/share.e2e.cjs`, Linux under Xvfb, real built app): a fake Windows profile
(`SSW_SHARE_FAKE_CLOUD`) with OneDrive and Dropbox folders; Settings › Share lists them with their
sources; a picked folder is added; a Slack webhook is added (masked), tested against a local mock
(`SSW_SHARE_WEBHOOK_ORIGIN`), a non-Slack URL refused; an export with "Copy to OneDrive" and "Post to
#demos" chosen ends with the file in `OneDrive/Flown`, the mock received the message with "Saved to
OneDrive › Flown" and no path; choices remembered for the preset and not for another; a second
share of the same file gets " (2)"; `share.json` holds no plain URL; the log holds no URL secret.

## 10. Verification needed on a real Windows PC
Registry detection of OneDrive personal / business, Dropbox `info.json`, Google Drive for desktop
(stream and mirror), copying into an On-Demand folder, notification buttons, posting through a
corporate proxy.

## 11. Left for later
* Share links through the user's rclone (`rclone link`) or the services' APIs.
* Teams Workflows webhooks, generic webhooks (n8n) behind an explicit "I trust this host" step.
* Batch and per-chapter exports (one message for many files).
* Localised Google Drive folder names.
