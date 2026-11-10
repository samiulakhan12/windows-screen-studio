# Translations

Flown's UI text in other languages: drafted at development time, corrected and approved by people,
and shipped only when two people have approved it. The design is
`docs/design/output-and-languages.md`, sections 9 and 15 to 16. Nothing in this folder ships in the
app: drafts, notes, the reviewers' names and the glossary stay in the repository.

## What is here

| Path | Holds | Written by |
|---|---|---|
| `reviewers.json` | the people who may review and approve, with their languages, the kind of agreement they signed and the date | the owner only |
| `glossary.csv` | the agreed words: term, part of speech, note, do-not-translate, then `bn`, `es`, `hi` | the reviewers, before any draft |
| `<lang>/<ns>.json` | one entry per message key: `text`, `state` (`draft`, `reviewed`, `approved`), `sourceHash`, `draftedWith`, `reviewedBy`, `reviewedAt`, `approvedBy`, `approvedAt`, `note` | the drafting script, then the reviewers through the sheet |
| `<lang>/review.csv` | the review sheet (not committed while it is being edited) | `npm run i18n:sheet` |
| `<lang>/pack/` | the review pack: screenshots with each message's key (not committed) | `npm run i18n:pack` |

The English messages are in `src/shared/i18n/messages/en/<ns>.json`, each with a meta entry (what it
is, where it shows, its length limit, the terms that stay untranslated) in `<ns>.meta.json`.

## Languages and the service that drafted them

| Language | Reviewers | Drafting service |
|---|---|---|
| Bangla (`bn`) | the owner and one more person, both writing Bangladesh's standard Bangla | not chosen yet: nothing is drafted |
| Spanish (`es`) | two people, found by the owner | not chosen yet |
| Hindi (`hi`) | two people, found by the owner | not chosen yet |

Before a service drafts anything, its terms must allow commercial use of its output. Name it in the
table above; each drafted entry records it in `draftedWith`.

## The steps, per language

1. **Agreements.** Each reviewer signs a contributor licence or an assignment to Qbexel, or works
   under a contract that assigns the work, before their first string is accepted. The owner then
   adds them to `reviewers.json`. The checks refuse anyone who is not listed for the language.
2. **Glossary first.** The two reviewers agree the words in `glossary.csv` (about 200 to 300 terms),
   after showing the 30 most visible ones to five people Flown is for and noting what they understood.
   Terms marked do-not-translate (brand, codec, format, editor and unit names) stay exactly as they
   are in every translation; the checks enforce it.
3. **Drafts.** A person runs `node scripts/i18n/draft.mjs --lang bn --ns <namespace>` on their own PC
   with their own key for the chosen service. It sends only the English messages of one namespace,
   their descriptions, placeholders and length limits, the glossary rows and the guard tour's
   screenshots of fixture projects, never a user's data. It writes `state: "draft"` entries; a draft
   that fails the checks keeps the check's message as its note.
4. **Review in context.** `npm run i18n:pack -- --lang bn` saves one screenshot per screen with each
   message's key drawn beside its text, and the `bn-XA` screenshots that show text too long or too
   tall for its place, as a folder with one HTML page. Open `index.html`; nothing has to be installed.
5. **The sheet.** `npm run i18n:sheet -- export --lang bn` writes `bn/review.csv`. Open it in Excel,
   correct the `final` column, and set `state` to `reviewed` (the first reviewer) or `approved` (the
   second), with your id in `reviewer` or `approver`. **Save it with Excel's "CSV UTF-8 (Comma
   delimited)"**: any other CSV type turns Bangla into question marks, and the import refuses it.
   A cell that starts with `=`, `+`, `-` or `@` gets an apostrophe in front so Excel never reads it
   as a formula; the import removes it again.
6. **Import.** `npm run i18n:sheet -- import --lang bn --file bn/review.csv --by <your id>` checks
   every row and records you and the date. It refuses a file that is not UTF-8, rows that look
   damaged (runs of `?`, no Bangla letter where English has words, a formula's remains), rows that
   fail the checks, and one person as both reviewer and approver of a string. Only the text a reviewer
   marked reviewed can be approved: if you correct it, set `state` to `reviewed`, and the other
   person approves it.
7. **Build.** `npm run i18n:build` writes `src/shared/i18n/built/` from the strings that are
   approved, current and approved by two different listed people. Commit the result;
   `npm run i18n:check` fails when the committed files differ from what the translations give.

## When a language ships

A language appears in Settings › Language when 95% of its keys and every key of the core
namespaces (every namespace except `commands`, `review`, `smart` and `recording`, whole-sentence
messages included) are approved and current. Until the other account's `recording` namespace is
approved too, it ships as a preview. A string that is not approved shows in English, on its own.

When an English message changes, its translations become stale: they leave the built catalogue at the
next build, and the sheet lists them first.

## For developers

- `npm run i18n:check`: the string scanner and every catalogue check.
- `npm run i18n:pseudo`: writes the pseudo-locales `en-XA` (accented, bracketed, 40% longer),
  `bn-XA` (Bengali letters with reph, chandrabindu, below-base forms and conjuncts, about 30%
  longer) and `ar-XB` (mirrored, right to left) under `scripts/i18n/pseudo/`, which is not committed.
  Each comes with a folder in the built format that an unpackaged build reads through
  `SSW_I18N_CATALOGUE_DIR`.
- The review build: `FLOWN_I18N_REVIEW=1 npm run i18n:pack -- --lang bn --live` writes the draft
  catalogue with each message's key and state marked, then starts `npm run dev` on it. Choose the
  language in Settings › Language. Hovering any text shows its key and state, Ctrl+Alt+K copies the
  key, and strings still in draft have a dotted underline. A packaged build never shows it.
