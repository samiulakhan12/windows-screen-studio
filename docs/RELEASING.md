# Releasing a new version of Flown

Flown 0.7.1 and later update themselves from this repository's GitHub releases
(`docs/design/auto-update.md`). A release reaches users only when a person publishes it.

## The steps

1. **Version and notes.** In `package.json`, raise `version` (for example `0.7.1` to `0.7.2`; run
   `npm version 0.7.2 --no-git-tag-version` so `package-lock.json` follows). In
   `docs/RELEASE-NOTES.md`, give the new version its own `## 0.7.2` section at the top: what
   changed, in plain words. Flown shows this text under *What's new* in Settings › About. Commit and
   push to the default branch.
2. **Build.** On GitHub: *Actions* › *Release* › *Run workflow*. It takes about half an hour. It
   stops at once, without building, when the version already has a release or a tag, or the notes
   have no section for it.
3. **Try the draft.** Under *Releases* there is now a **draft** "Flown 0.7.2" with
   `Flown-Setup-0.7.2.exe` and `latest.yml`. Drafts are invisible to Flown. Download the installer
   and try it; the workflow's summary page shows its SHA-256.
4. **Publish.** Open the draft, press *Edit*, then **Publish release**. From then on every copy of
   Flown with *Update Flown automatically* on finds it within four hours (or at once with *Check for
   updates*), downloads it in the background and installs it when the user closes Flown.

Never edit or replace the files of a published release: Flown checks the installer against the
SHA-512 in `latest.yml`, so a changed file fails to install. Make a new version instead.

## Stopping a bad release

- **Not downloaded yet:** on the release page, press *Edit* and turn it back into a draft (or delete
  it). Copies that have not downloaded it stop being offered it. A copy that downloaded it but has
  not installed it yet drops it at its next check (it no longer installs when Flown closes), also
  when an older release or a fix is the latest now; it then takes that one instead. Ship the fix
  as a new version (for example 0.7.3): a deleted release keeps its tag, so the workflow refuses
  its version.
- **Already installed:** Flown never installs a lower version, so publish the fix as the next
  version (for example 0.7.3). Older installers stay on the Releases page for anyone who needs to
  reinstall one by hand.

## Keeping it safe

- Builds are not code-signed yet, so the GitHub account is what users trust: **use two-factor
  sign-in** on it, and give write access only to people who release. Whoever can publish a release
  can ship an update to every user.
- The *Release* workflow builds with a token that can only read the repository; only its last
  job, which runs no npm package and no build, can make the draft. Keep it that way when changing
  the workflow, so a bad dependency cannot publish a release or push.
- With a code-signing certificate configured (`docs/BUILDING.md`, Code signing), electron-builder
  writes the publisher's name into the app, and Flown then also checks that each downloaded
  installer is signed by that publisher. Windows SmartScreen stops warning as well.

## The list of suggested AI models

`resources/ai-models.json` names each AI provider's suggested models and the models their makers
are retiring. Copies of Flown with automatic updates on read it from the default branch at most once
a day, so a change to that file needs no release: edit it, raise `updated` to today's date
(`YYYY-MM-DD`; Flown never takes a list older than the one it has, and one of the same date
counts, so a second fix on the same day is fine), keep `BUNDLED_MODEL_LIST` in
`src/shared/ai/modelList.ts` equal to what this version takes from the file (a test checks), run
`npx vitest run tests/modelList.test.ts`, commit and push. A file Flown cannot read is ignored, so
a mistake never breaks anyone's copy.

Every installed version reads the same file, including old ones. To suggest a model that only newer
versions can use (one that needs new code, for example a transcription model without word times),
add `"minApp": "x.y.z"` to that provider's entry: versions from x.y.z on take the suggestion, older
ones keep the one they shipped with for that provider. For example
`"openai": { "model": "gpt-6.1-sol", "transcriptionModel": "gpt-transcribe", "minApp": "0.8.0" }`.
`BUNDLED_MODEL_LIST` keeps this version's own suggestion for that provider until `package.json`
reaches x.y.z; from that version on it has the new one.

## The music library's downloads

Four music beds and sixteen sound effects ship in the installer (`resources/sound-library/`,
checked by `scripts/verify-dist.mjs` against the pins in `src/shared/audio/soundLibrary.ts`). Eight
more beds download when a user asks, from a release of a separate repository, so publishing them
never touches this repository's update feed (docs/design/editing-polish.md §0 decision 1, §10.3):
`samiulakhan12/flown-sound-library`, tag `sound-library-1`, with GitHub's immutable releases turned
on. Until that release exists, `SOUND_LIBRARY_SOURCE` stays `null`: the app offers no download (the
eight rows are hidden, Settings › Downloads shows no More music group) and the four bundled beds work
alone. To turn the downloads on:

1. Create the repository and turn on immutable releases. Make the release `sound-library-1` and
   upload the eight prepared files (`bed-<id>.ogg`) **unchanged**: their bytes and SHA-256 must be
   exactly the `PREPARED` pins in `soundLibrary.ts`. A tag is never reused; a changed file is a new
   id in the catalogue and a new tag (`sound-library-2`).
2. The release check: before setting the source, download one real asset from the live host through
   the app's own path, `downloadPinned` with `allowSoundUrl`. In an unpackaged app, set
   `SOUND_LIBRARY_SOURCE` to `SOUND_LIBRARY_RELEASE` locally, open Settings › Downloads › More music,
   download one bed, and check that it is listed as downloaded and plays (its SHA-256 was checked
   on the way in). GitHub answers the release URL with a redirect to
   `release-assets.githubusercontent.com` (or `objects.githubusercontent.com`) and a signed query:
   if it ever redirects somewhere else, the download is refused, and `cdnHosts` must be reviewed
   before going on. Had the beds been published as a release of this repository instead (decision 1
   (b)), also check that `https://api.github.com/repos/samiulakhan12/windows-screen-studio/releases/latest`
   still names the app's own version tag, or every installed Flown would stop updating.
3. Set `SOUND_LIBRARY_SOURCE = SOUND_LIBRARY_RELEASE` in `soundLibrary.ts`, run
   `npx vitest run tests/soundLibraryStore.test.ts tests/editingContracts.test.ts`, and release
   the app as usual.
