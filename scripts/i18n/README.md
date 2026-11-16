# The string and translation tools

The tools of docs/design/output-and-languages.md §10, §15 and §16 (part P7). The reviewers' steps are in
`translations/README.md`. Every tool takes `--root <dir>` (this repository by default), reads the
English catalogue from `src/shared/i18n/messages/en/` and never changes a source file under `src/`.

| Command | What it does |
|---|---|
| `npm run i18n:check` (`check.mjs [--report]`) | The scanner, the English checks, the reviewers' record, the glossary, every translation and the built catalogues. `--report` keeps the scanner's findings outside `config.json`'s `failFor` a report, as before step S4. CI and `predist` step 5 run it. |
| `node scripts/i18n/scan.mjs [--verbose]` | The scanner alone: UI text without a key, `t()` at module scope, locale-less formatting, unknown keys. |
| `npm run i18n:build` (`build-catalogues.mjs [--check]`) | Writes `src/shared/i18n/built/` from approved, current strings of two listed people, and `shipped.json` (95% of the keys, every core key; a preview until `recording` is approved). Commit the result. |
| `npm run i18n:sheet -- export\|import --lang <l>` | The review sheet for Excel, and its import (see `translations/README.md`). |
| `npm run i18n:pack -- --lang <l>` | The review pack: the guard tour's screenshots with every key, and the `bn-XA` screenshots. Needs `npm run build` and xvfb. `--live` with `FLOWN_I18N_REVIEW=1` is the review build with the overlay. |
| `npm run i18n:pseudo` | `en-XA`, `bn-XA` and `ar-XB` under `scripts/i18n/pseudo/` (not committed), each also as a catalogue folder for `SSW_I18N_CATALOGUE_DIR`. |
| `npm run i18n:extract -- --ns <ns> --files <a,b>` | The codemod: a patch and a proposal (messages, meta, log rows, what needs a hand edit) under `scripts/i18n/extract/`. |
| `node scripts/i18n/split.mjs [--check]` | Splits the extraction between X1-X7 into `parts.json` (step S2). |
| `node scripts/i18n/fmt-sites.mjs [--check]` | Part X6's formatter call sites: any number, size, time, date or list our files still format with one of today's helpers instead of `fmt`, against `fmt-sites.json` (the calls moved to `fmt` and those kept with a reason). Test 73 runs the same check. |
| `node scripts/i18n/draft.mjs …` | Drafts one namespace with an AI service the README names, with your own key. Development only; see its header. |

Settings: `config.json` (`scan`, `failFor`), `allow.json` (what is not UI text, each with its reason),
`pending.json` (the other account's files and the requests that go with their agreement),
`built-baseline.json` (the previous release's size of the built catalogues, for verify-dist), and
`log/` (the extraction parts' log rows, which test 69 formats back).
