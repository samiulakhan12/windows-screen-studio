# Build report: Share without a server (F-22)

Branch `feat-share`, from `ccr-b6df7cf7-yked87` (546e479). Design: `docs/design/share.md`.

## What was built

* **Cloud folders.** Flown finds OneDrive (personal and work accounts in the registry, its environment
  variables), Dropbox (`info.json` in Roaming / Local AppData, then `%USERPROFILE%\Dropbox`) and Google
  Drive for desktop (its `PerAccountPreferences` mounts and `DefaultMountPoint`, then `G:\My Drive`,
  `%USERPROFILE%\My Drive`, `%USERPROFILE%\Google Drive`), keeps those that exist, and lists each in
  Settings › Share with its path, where it was found and a *Use* switch. Any other folder can be added
  with the folder dialog. An export is copied into `<folder>\Flown` through a hidden partial file
  renamed when complete, with progress, Cancel, a free-space check, no replacing (" (2)"), and a
  refusal when `Flown` is a link that leads elsewhere.
* **Chats.** Slack, Discord and Microsoft Teams incoming webhooks, checked (HTTPS, the services' own
  hosts and path shapes, no port, credentials or fragment, ≤ 1024 characters), stored encrypted with
  safeStorage exactly like AI keys (nothing stored without safe encryption), shown masked
  (`hooks.slack.com/…/AbCd`), with *Test*. A post is a short message (title, length, "Saved to
  OneDrive › Flown", or the link when one is known), escaped per service so it cannot ping
  `@channel` / `@everyone`; never a local path, never the video. No redirects, 15 s, 4 KB body,
  16 KB of the answer read, errors name the service and never the URL.
* **After export.** A row in the export dialog's settings (after *Also save*), remembered per preset in
  localStorage; single exports only. The done view's *Share* block shows each step, Cancel, *Try
  again*, *Show in folder*, how to get a share link, and buttons for the destinations not used. The
  "Export finished" notification gets up to 3 extra buttons ("Copy to OneDrive", "Post to #demos")
  when the page did not share the file itself; a share that ends in the background notifies its
  result.
* **Log.** One new redaction rule: the secret part of Slack / Discord / Teams webhook URLs becomes
  `<secret>`. Share logs only "Share: copied 1 file to onedrive" / "Share: posted to slack".

## Decisions (why)

* The cloud app's own folder instead of the services' APIs: no OAuth, no client ids, no tokens, no
  upload code; the cloud app handles retries and metered networks (§2.1).
* Share links: none of the three desktop apps offers a local, documented way to make one, so Flown
  never invents one and says how (right-click › Share). The model keeps a `link` per copy for a later
  source such as rclone (§2.4).
* Strict webhook hosts: a pasted URL must not become a way to send data anywhere (§2.5). Teams
  Workflows (`*.logic.azure.com`) and generic webhooks are left for later.
* Main owns the runs (copy and network are main-only; the page's CSP blocks requests); the page and
  the notification start them through one code path (§2.8).
* Shared files touched beyond the listed ones, each additive and unavoidable: `src/main/longJobs.ts`
  and `src/main/longJobsPort.ts` (the notification is built there: `setNotificationExtras`, extra
  buttons after Open / Show in folder; nothing changes when no provider is set) and
  `src/shared/diagnostics/redact.ts` (one rule). No new dependency. `project.json` unchanged.

## Tests

Unit (vitest), each checked to fail without its code (mutation of the rule → a failing test):
`tests/shareWebhooks.test.ts`, `shareCloud.test.ts`, `shareStore.test.ts` (with the per-preset
choices), `shareCopy.test.ts` (copy and post, against a local HTTP server), `shareService.test.ts`,
`shareNotify.test.ts` (the notification seam).

End-to-end: `tests/e2e/share.e2e.cjs`, the built app under Xvfb with a fake Windows profile
(`SSW_SHARE_FAKE_CLOUD`) and a local Slack stand-in (`SSW_SHARE_WEBHOOK_ORIGIN`): folders found with
their sources, a folder added, a webhook refused without a keyring, a foreign URL refused, Slack's
added masked and tested, an export copied to OneDrive/Flown and posted ("New video: Demo (0:03)\nSaved
to OneDrive › Flown", no path), Dropbox offered and copied afterwards, choices remembered for the
preset and not another, the notification offering the destinations, refusals from main, no webhook
secret in `share.json` or the log. Screenshots: `docs/screenshots/share-settings.png`,
`share-after-export.png`, `share-done.png`.

## Verification

VERIFICATION

## Needs a real Windows PC

* Registry detection of OneDrive personal and business accounts, Dropbox `info.json`, Google Drive for
  desktop in stream (`G:\My Drive`) and mirror mode; a user name outside the console code page.
* Copying a large file into a Files On-Demand folder (OneDrive, Google Drive stream): speed, progress,
  Cancel.
* The notification's extra buttons (Windows shows up to 5) and the "Shared" notification.
* Posting through a corporate proxy (`net.fetch` uses the system proxy) and `redirect: 'manual'`.

## Left for later

Share links through the user's rclone or the services' APIs; Teams Workflows and other webhooks
behind an explicit trust step; batch and per-chapter exports; localised Google Drive folder names.
