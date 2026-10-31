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
