# Deciding what is private: rules for screen text (OCR) and speech

Researcher "detect", 23 Nov 2026, for the auto-blur wave (F-07, LT-05). Everything here was checked again
against the code at `rev/autoblur-design` 37f9355 and against the sources listed at the end. The rules are
written so a builder can implement them as pure functions in `src/shared/privacy/detect/`. A prototype of
every rule (`scripts/rules.mjs`, 934 lines, my own code) passes all 203 vectors in `vectors.json` and was
scored end to end on the real OCR reads of the 24-frame evaluation set (section 11).

Measurements were single-threaded Node 22.23.5 (V8 12.4) under `nice` on a 4-CPU machine shared with a setup
job, so times are upper bounds.

---

## 0. Terms used in the tables

| Term | Meaning |
|---|---|
| **line** | One OCR text line (a box): `text`, `bbox`, and the x-range of each character (`spans`, one per UTF-16 unit of `text`; the CTC columns give these). |
| **row** | The boxes whose vertical centres lie within 0.6 × line height of each other. A label box and its value box are often separate boxes on one row (`SECRET_KEY =` and `"django-insecure-…"`; `Router admin PIN · From the sticker · 58204716`). |
| **above** | The nearest line above in the same column: it ends at most 2.2 line heights above this one and overlaps it horizontally by ≥ 30 % (or starts within one line height of its left edge). |
| **own span** | The secret's own characters `[start, end)` in the line text, never padded. Everything that re-finds the secret elsewhere ("Cover this text everywhere", spoken forms, the AI masks) is built from the own span. Review finding 11 was a matcher built from the padded span. |
| **cover rect** | The own span's x-range (from `spans`) and the line's y-range, padded by `max(3 px, 0.35 × line height)` on every side, clipped to the frame (finding 22: never round past the frame edge). Keys and PEM lines use the block's full width (section 6). |
| **score** | 0–1. **auto** ≥ 0.85; **Check** 0.50–0.85; below 0.50 nothing is suggested. |
| **label** | A word or phrase in the `LABELS` table of the kind (en, bn, es, hi: the four UI languages, `src/shared/api/ui.ts:55`). |

### 0.1 Tiers (recommendation)

- Every suggestion at or above 0.50 is drawn as a cover in preview and export, because a miss is worse than an
  extra box (§0 decision 2). "Check" rows are listed first in Review and counted on the export note; "auto"
  rows are listed as found.
- The scores fixed by the accepted decisions are kept: secret QR codes 0.99, other QR codes 0.6, strong labels
  0.75 (decision 2).
- A suggestion's score is the highest of its reads while it is followed; a later read never lowers it.

### 0.2 Defaults (decision 2, unchanged)

On: passwords and PINs, codes and QR codes, keys and tokens with strong labels, tokens in links and webhooks,
emails, card and bank numbers, phones (the PC's region, the UI language's region and up to 5 added), ID numbers
with a label plus SSN and NI formats, listed names, pop-up notices in whole-screen recordings.
Off: addresses, password dots, unlabelled random-looking strings.

---

## 1. The pipeline for one read of one frame

1. **Clean each line** (`clean`, index-mapped, same order as the raw text):
   NFKC per character; every dash `U+2010–2015, U+2212, U+FE58, U+FE63, U+FF0D` → `-`; bullet-like dots
   `• ● ∙ ⦁ ⚫ ⬤ ‧ ・` → `•`; zero-width and soft hyphen removed; any space → ` `; inside a token that holds an
   ASCII letter or digit: `θ Θ ø Ø ⊘` → `0` (slashed and dotted zeros of programming fonts come back as θ),
   `×` → `x`, Greek and Cyrillic lookalikes (А В Е К М Н О Р С Т Х а е о р с у х, Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ ο ν ρ)
   → Latin. Bengali and Devanagari digits stay as written in the text; views convert them.
2. **Views**, all the same length as the cleaned text so spans map one to one:
   - *digit view*: Bengali and Devanagari digits → ASCII (as `asciiDigits`, `src/shared/captions/numbers.ts:22`);
     then in each run of digit groups (joined by ≤ 2 of ` .-/()`) holding ≥ 6 real digits and at most one
     confusable letter per 5 characters, the confusables of each group that holds a real digit become digits:
     `O o D Q → 0`, `l I | i ! → 1`, `S s → 5`, `B → 8`, `Z z → 2`, `G b → 6`, `g q → 9`, `T → 7`.
   - *prefix view*: where a token starts with a known prefix up to OCR confusions (`0/o/O`, `1/l/I/i/|`,
     `5/s/S`, `8/B/b`, `2/z/Z`, `9/g`, `_`/space, any dash), the prefix is rewritten (`x0xb-` → `xoxb-`,
     `AK1A` → `AKIA`, `Alza` → `AIza`), only when ≥ 8 token characters follow.
   - *URL view*: inside a link, a single space between two runs of ≥ 6 token characters is dropped (OCR reads
     `_` as a space: `…/6yUS3ySt 0qAq6…`), also when the run ends in `. , ; )`.
   - *label view*: inside words with ≥ 2 letters, `0→O 1→I 5→S 8→B` (`EMAIL_H0ST_PASSW0RD`, `SLACK_B0T_T0KEN`).
     Labels are matched only on this view.
3. **Line rules** (sections 2–5), each giving `{kind, rule, own span, score}`.
4. **Row and column rules** (section 6): a value beside a label on its row, under a short label line, under a
   sentence that names a code, in a recovery-codes block.
5. **Frame rules** (section 6): PEM blocks, keys that wrap at the right edge, recovery-code grids.
6. **Dedupe**: keep the higher score; a hit contained in a kept hit is dropped. Never drop a hit because it
   overlaps a lower-scored one of another kind.
7. **Cover rects** from own spans (section 0).

The prototype's line rules cost 40–250 µs a line on this loaded machine (about 37 lines a 1080p frame in the
evaluation set, so 1.5–9 ms a frame, small next to the read itself); the prefix view is the costly part and should be one trie or one combined regex in the
product.

---

## 2. Emails

| Rule | Pattern (on the cleaned text) | Checks | Score |
|---|---|---|---|
| email | `(?<![A-Za-z0-9._%+/-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})(@)((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+)([A-Za-z]{2,24})(?![A-Za-z0-9@])` | TLD in Flown's IANA list (`X_GENERIC_TLDS`, `X_COUNTRY_TLDS`, `src/shared/publish/tlds.ts:22,118`, from twitter-text 3.1.0, Apache-2.0) | 0.95 |
| email-ocr | same with `\s?([@©®])\s?` and label separators `\s?[.,·]\s?`; tried only where the strict form found nothing (otherwise `x@y.io · Sales` swallows "Sales" as a TLD and the whole match fails) | as above | 0.75 |
| role address | local part `no-?reply, do-?not-?reply, notifications?, support, info, hello, contact, sales, admin, postmaster, webmaster, team, help, billing, security, privacy, press, jobs, careers, feedback` | | 0.60 |
| reserved domain | TLD `test, example, invalid, localhost` (RFC 2606/6761) or `example.com/.org/.net` | a stand-in for a real address is still covered | 0.60 |
| not an email | `git@host:` (SSH remote); `@2x.png` (TLD not in the list); `@types/node`; `user@HOST` without a TLD; text right after `//` (a DSN's key, section 4) | | — |

Spoken: section 9.4.

---

## 3. Numbers: cards, bank accounts, phones, IDs

### 3.1 Payment cards

Candidate (digit view): `(?<![\p{L}\p{N}.,/-])\d(?:[ -]?\d){11,18}(?![\p{L}\p{N}]|[.,/-]\d)`, then:

- **Grouping**: no separators; or one kind of separator with every group but the last a multiple of 4
  (OCR drops spaces: `4783 58545363 5299`) and the last 1–4 or a multiple of 4; or Amex/Diners `4-6-5`, `4-6-4`.
- **Luhn** (mod 10 over the digits, doubling every second from the right).
- **IIN and length** (Wikipedia "Payment card number"): Visa 4 (13, 16, 19); Mastercard 51–55 and 2221–2720 (16);
  Amex 34, 37 (15); Discover 6011, 644–649, 65 (16–19); Diners 300–305, 36, 38–39 (14–19); JCB 3528–3589 (16–19);
  UnionPay 62 (16–19); Maestro 5018, 5020, 5038, 5893, 6304, 6759, 6761–6763 (12–19); Mir 2200–2204 (16–19);
  RuPay 60, 508, 81–82 (16); Verve 506099–506198, 507865–507964, 650002–650027 (16, 18, 19); Troy 9792; Dankort 5019;
  InterPayment 636; InstaPayment 637–639; Uzcard 8600; HUMO 9860; Napas 9704 (16, 19); UATP 1 (15).
  The ISO/IEC 7812 IIN is 6 or 8 digits (10 since the 2017 edition), so prefixes are compared as written.

| Rule | When | Score |
|---|---|---|
| card-luhn | Luhn + IIN/length, grouped or labelled | 0.96 |
| card-luhn (bare) | Luhn + IIN/length, no grouping, no label | 0.88 |
| card under another label | text before it names `ref, reference, order, invoice, tracking, ticket, serial, sku, imei, iccid, isbn, ean, upc` or ends in `#` | 0.60 |
| card-misread | **card label** + IIN + 4-4-4-4 grouping, Luhn fails (one digit misread) | 0.80 |
| card-labelled | card label, 13–19 digits | 0.70 |
| cvv | `CVV, CVV2, CVC, CVC2, CSC, card security code, card code` + 3–4 digits right after; or a lone 3–4 digit box under or beside that label | 0.90 |
| skipped | published test numbers (allow list: Stripe's 4242…4242, 4000056655665556, 5555555555554444, 2223003122003222, 5200828282828210, 5105105105105100, 378282246310005, 371449635398431, 6011111111111117, 6011000990139424, 3056930009020004, 36227206271667, 3566002020360505, 6200000000000005, and 4111111111111111, 4012888888881881); ≥ 75 % zeros or ≤ 2 distinct digits; masked (`•••• 4242`, the last four alone are not covered) | — |

Why the misread rule needs a label: on 1,000 random `Ref dddd dddd dddd dddd` lines the unlabelled
version fired on 280 (28 %). A single misread digit always breaks Luhn, but another read of the same text
while it is followed gives the true digits, so the label-less case is left to those reads. Random grouped
16-digit numbers pass Luhn + a major IIN 2.6–3.9 % of the time (measured, section 11.2), which is why a
reference label lowers them to Check.

### 3.2 IBAN and bank numbers

- Candidate (as written, upper case): `(?<![A-Za-z0-9])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{1,4}){3,9})(?![A-Za-z0-9])`,
  cut to the country's length. Lengths (SWIFT registry countries, via Wikipedia): AL28 AD24 AT20 AZ28 BH22 BY28
  BE16 BA20 BR29 BG22 BI27 CR22 HR21 CY28 CZ24 DK18 DJ27 DO28 TL23 EG29 SV28 EE20 FK18 FO18 FI18 FR27 GE22 DE22
  GI23 GR27 GL18 GT28 HN28 HU28 IS26 IQ23 IE22 IL23 IT27 JO30 KZ20 XK20 KW30 LV21 LB28 LY25 LI21 LT20 LU20 MT31
  MR27 MU30 MC27 MD24 MN20 ME22 NL18 NI28 MK19 NO15 OM23 PK24 PS29 PL28 PT25 QA29 RO24 RU33 LC32 SM27 ST25 SA24
  RS22 SC31 SK24 SI19 SO23 ES24 SD18 SE24 CH21 TN24 TR26 UA29 AE23 GB22 VA22 VG24 YE30 (89 countries; the
  builder should take the list from the registry release current at build time).
- **mod 97**: move the first four characters to the end, letters → 10–35, the number mod 97 must be 1.
- **Repair**: when mod 97 fails, try one, then two, swaps among `0/O 1/I 5/S 8/B 2/Z 6/G` after the first four
  characters (at most 12 positions); a pass means an OCR misread (`AB1O` read `AB10`).

| Rule | When | Score |
|---|---|---|
| iban | mod 97 = 1 | 0.97 |
| iban-repaired | a repair passes | 0.85 |
| iban-labelled | `IBAN` label, mod 97 fails | 0.75 |
| skipped | the published examples `GB82WEST12345698765432`, `DE89370400440532013000`; text with `XXXX` or ≥ 10 zeros; lower-case text (hex upper-cased read as IBANs in code) | — |

Account, routing, sort-code and BSB numbers are covered only with a label (3.4).

### 3.3 Phone numbers

Library: libphonenumber-js metadata (section 10.1), read as data. Its matcher offers only `POSSIBLE` and
`VALID` leniency; `STRICT_GROUPING` and `EXACT_GROUPING` throw (`es6/PhoneNumberMatcher.js:145-146` in 1.13.16),
so the grouping check is ours. Bengali and Devanagari digits must be converted first: its `parseDigits`
maps Arabic-Indic, Persian and full-width digits only.

Why gates are needed (measured on the metadata, 20,000 random digit strings a cell): the share of random
national numbers of a valid length that pass the general pattern / the max type patterns is US 10 digits
80.2 % / 30.8 %, GB 10 digits 70.5 % / 27.7 %, BD 8 digits 79.6 % / 8.2 %, IN 10 digits 89.8 % / 63.4 %, DE 6–12
digits ≈ 90 % / ≈ 70 %, FR 9 digits 89.8 % / 82.6 %. A bare digit run is never enough.

Candidate (digit view): `(?<![\p{L}\p{N}./:-])(\+|00)?\s?(\(?\d[\d\s().-]{5,20}\d)(?![\p{L}\p{N}]|[./:]\d)`;
rejected when it is a date (`yyyy-mm-dd`, `d/m/y`), an IPv4 address, a time, a decimal (`\d\.\d` not in a
2–4-digit group, `.5`, `-.8`), or a match inside a hit already made.

| Rule | When | Score |
|---|---|---|
| phone-intl | `+` or `00`, calling code, national number VALID (max metadata) for one of the code's regions | 0.92 |
| phone-intl (possible) | `+` and a POSSIBLE length only, grouped (Ofcom's drama range `+44 7700 900461` is unallocated, so not VALID, and still a phone on screen) | 0.85 (0.60 ungrouped) |
| phone-labelled | VALID for one of the user's regions, a phone label on the line or above (`phone, tel, telephone, mobile, cell, fax, whatsapp, call, teléfono, móvil, celular, ফোন, মোবাইল, টেলিফোন, फ़ोन, फोन, मोबाइल`; not `no.`, `nº` or bare `নম্বর`, which also label orders) | 0.92 |
| phone-grouped | VALID, and the written groups follow one of the region's formats (metadata `formats`, leading-digits pattern first; groups may join neighbouring format groups; the national prefix may sit on the first group) | 0.85 |
| phone-bare-mobile | VALID mobile (the region's mobile pattern differs from its fixed-line one, so never NANP) written with its national prefix (`01712345678`), and no `order, invoice, ticket, ref, tracking, sku, account, serial, build, version, id, #` on the line | 0.60 |

Regions: the PC's region, the UI language's region (`bn` → BD, `hi` → IN, `es` → ES, `en` → none extra), and up
to 5 the user adds (decision 2). International numbers need no region.

### 3.4 ID numbers

| Rule | Pattern / check | Score |
|---|---|---|
| ssn | digit view `(\d{3})([- ])(\d{2})\2(\d{4})`, area not `000`, `666`, `9xx`; group not `00`; serial not `0000` (SSA: randomised since 25 Jun 2011, these never assigned). No allow list: published samples (078-05-1120, 219-09-9999) are covered too | 0.85 (0.95 with an ID label) |
| uk-nino | as written: `(?<![A-Za-z0-9])((?!BG\|GB\|KN\|NK\|NT\|TN\|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?([A-D])(?![A-Z0-9])` (HMRC NIM39110: D, F, I, Q, U, V never in the prefix; O never second; BG, GB, KN, NK, NT, TN, ZZ not allocated; suffix A–D). `QQ123456C` with an NI label is still covered by id-labelled | 0.85 |
| id-labelled | an ID label (table below) right after which (separator `: = ： #` or `no.`, quotes allowed), under which (a short label line) or beside which (a label box to the left on the row) stands `[A-Z0-9][A-Z0-9 -]{3,28}[A-Z0-9]` with ≥ 4 digits making ≥ 50 % of it; every label on the line counts (`Employee ID: EMP-002931 · Payroll ID: PR-55102` gives two) | 0.85 |
| licence key | Windows charset `(?:[BCDFGHJKMPQRTVWXY2346789]{5}-){4}[BCDFGHJKMPQRTVWXY2346789]{5}` with a digit (0.90); after `licence key, product key, serial, activation key/code, registration key/code`: `[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}` or `[A-Z0-9]{12,40}` with a digit (0.85) | 0.85–0.90 |

ID labels (en, bn, es, hi): account number/no./#, acct, a/c, customer ID/number, member ID/number, policy
number, passport (no./number), driver's licence number, licence number, tax ID, TIN, EIN, ITIN, SSN, social
security (number), national insurance (number), NI number, NINO, NID, national ID, ID number/no., Aadhaar, PAN,
NHS number, Medicare, routing (number), ABA, sort code, BSB, employee ID, student ID, payroll ID, tax file number,
TFN, SIN, social insurance number, DNI, NIE, CPF, CURP, RFC, número de cuenta, cuenta, জাতীয় পরিচয়(পত্র), এনআইডি,
হিসাব নম্বর, অ্যাকাউন্ট নম্বর, পাসপোর্ট, खाता संख्या, आधार, पैन. A label followed by words ("Account number must
have 10 digits") gives nothing.

---

## 4. Keys, tokens and secrets in links

Source: gitleaks v8.30.1 (`config/gitleaks.toml`, 97,731 bytes, SHA-256
`e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf`, identical to master `5f6ec56` on 23 Nov 2026;
tag commit `83d9cd68`; 222 rules; MIT, Copyright (c) 2019 Zachary Rice). The rules below are translated
to JavaScript: Node 22.23 (V8 12.4) rejects regex modifiers `(?i:…)` (tested: "Invalid group"), so a leading
`(?i)` becomes the `i` flag, a mid-pattern `(?i)` and `(?-i:…)` are spelled out as character classes, `(?P<n>`
becomes `(?<n>`, and `\z` becomes `$`. The boundary `\b` is replaced by `(?<![A-Za-z0-9_])` and
`(?![A-Za-z0-9_])` because a token may start or end with `-`. Prefix letters are matched on the prefix view.

### 4.1 Strong prefixes (stand alone; run on the prefix view)

| id | JS pattern | Score | gitleaks rule (line in gitleaks.toml) |
|---|---|---|---|
| anthropic | `(?<![A-Za-z0-9_])sk[-–]ant[-–](?:api\|admin)0\d[-–][A-Za-z0-9_-]{80,100}(?![A-Za-z0-9_])` | 0.98 | anthropic-api-key (150), anthropic-admin-api-key (144): `sk-ant-api03-[a-zA-Z0-9_\-]{93}AA` |
| openai | `…sk[-–](?:proj\|svcacct\|admin)[-–][A-Za-z0-9_-]{40,200}…` | 0.98 | openai-api-key (2704) |
| openai-legacy | `…sk-[A-Za-z0-9]{20}T3B[l1I]bkFJ[A-Za-z0-9]{20}…` (`T3BlbkFJ` is base64 of "OpenAI") | 0.98 | openai-api-key (2704) |
| sk-generic | `…sk[-–](?:or-v1-)?[A-Za-z0-9_-]{24,}…` (DeepSeek, OpenRouter, and the shape Flown's own `redact.ts:41` already uses) | 0.90 | — |
| github | `…gh[pousr][_ -]?[0-9A-Za-z]{34,38}…` (36 ± 2: CTC drops or doubles one character) | 0.97 | github-pat (2159), github-oauth (2152), github-app-token (2131), github-refresh-token (2170): `gh[pousr]_[0-9a-zA-Z]{36}` |
| github-fine | `…github[_ -]?pat[_ -]?[0-9A-Za-z_]{80,84}…` | 0.98 | github-fine-grained-pat (2145): `github_pat_\w{82}` |
| gitlab | `…gl(?:pat\|dt\|ptt\|rt\|cbt\|soat\|ffct\|ft\|imt\|agent\|oas)-[0-9A-Za-z_-]{20,}…` | 0.97 | gitlab-pat (2226): `glpat-[\w-]{20}`, gitlab-pat-routable (2233) and the other gitlab-* rules |
| slack | `…xox[baprseo][-–][0-9A-Za-z-]{10,}…` | 0.97 | slack-bot-token (2971), slack-user-token (3022), slack-legacy-token (3002), slack-config-access-token (2978) |
| slack-app | `…xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+…` | 0.97 | slack-app-token (2964) |
| aws-id | `…(?:A3T[A-Z0-9]\|AK[I1l]A\|ASIA\|ABIA\|ACCA)[A-Z2-7]{16}…`; skip `…EXAMPLE` | 0.92 | aws-access-token (206) |
| google | `…A[I1l\|]za[0-9A-Za-z_-]{33,37}…` | 0.97 | gcp-api-key (612): `AIza[\w-]{35}` |
| stripe | `…(?:sk\|rk)_(?:live\|test\|prod)_[0-9A-Za-z]{10,99}…` | 0.97 | stripe-access-token (3077) |
| stripe-webhook | `…whsec_[0-9A-Za-z]{24,}…` | 0.97 | — |
| stripe-pk | `…pk_(?:live\|test)_[0-9A-Za-z]{10,99}…` (publishable, public by design) | 0.60 | — |
| sendgrid | `…SG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{40,46}…` | 0.97 | sendgrid-api-token (2855) |
| twilio-key | `…SK[0-9a-fA-F]{32}…` | 0.85 | twilio-api-key (3117) |
| npm | `…npm[_ -]?[A-Za-z0-9]{30,38}…` | 0.97 | npm-access-token (2659) |
| pypi | `…pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}…` | 0.98 | pypi-upload-token (2809) |
| huggingface | `…hf[_ -]?[A-Za-z0-9]{32,36}…` (gitleaks allows letters only; OCR reads O as 0) | 0.95 | huggingface-access-token (2364) |
| azure-ad-secret | `(?<![A-Za-z0-9_~.])[a-zA-Z0-9_~.]{3}\dQ~[a-zA-Z0-9_~.-]{25,34}` | 0.95 | azure-ad-client-secret (237) |
| digitalocean | `…do[pro]_v1_[a-f0-9]{64}…` | 0.98 | digitalocean-pat (408) and siblings |
| shopify | `…shp(?:at\|ss\|ca\|pa)_[a-fA-F0-9]{32}…` | 0.97 | shopify-access-token (2918), shopify-shared-secret (2939) |
| linear | `…lin_api_[A-Za-z0-9]{40}…` | 0.97 | linear-api-key (2478) |
| notion | `…(?:ntn_[0-9]{11}[A-Za-z0-9]{35}\|secret_[A-Za-z0-9]{43})…` | 0.95 | notion-api-token (2652) |
| perplexity | `…pplx-[A-Za-z0-9]{48}…` | 0.97 | perplexity-api-key (2718) |
| sentry | `…sntr[ys]u?_[A-Za-z0-9_=+/]{40,}…` | 0.95 | sentry-user-token (2883), sentry-org-token |
| grafana | `…glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}…` | 0.97 | grafana-service-account-token (2311) |
| vault | `…hvs\.[A-Za-z0-9_-]{90,120}…` | 0.97 | vault-service-token (3173) |
| databricks | `…dapi[a-f0-9]{32}(?:-\d)?…` | 0.95 | databricks-api-token (382) |
| postman | `…PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34}…` | 0.97 | postman-api-token (2771) |
| heroku | `…HRKU-AA[0-9A-Za-z_-]{58}…` | 0.97 | heroku-api-key-v2 (2351) |
| age | `…AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}…` | 0.99 | age-secret-key (106) |
| telegram | `(?:(?<=bot)\|(?<![A-Za-z0-9_]))[0-9]{8,10}:AA[A-Za-z0-9_-]{33}…` (also inside `api.telegram.org/bot…/`) | 0.92 | telegram-bot-api-token (3105) |
| jwt | `…e[yv][JIl1][A-Za-z0-9_-]{10,}\.e[yv][JIl1][A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}…` | 0.93 | jwt (2424) |
| azure-conn | `(?:AccountKey\|SharedAccessKey)=[A-Za-z0-9+/]{30,}={0,2}` | 0.97 | — |
| private-key | `(?:^\|[\s"'-])BEG[I1l]N\s+(?:[A-Z0-9]+\s+){0,3}PR[I1l]VATE\s+KEY(?:\s+BLOCK)?\b` (OCR gives ` - - --BEGIN PRIVATE KEY-- - - -` and `BEGIN OPENSSH PRIVATE KEY- -`; the dashes are not required). Public keys and certificates are not covered | 0.99 | private-key (2785) |

Every strong rule skips a payload with `XXXX`, `xxxxxx`, ≥ 8 zeros, `****`, `....` or ≤ 2 distinct characters in
its last 12 (`xoxb-XXXXXXXXXXXX` in docs), and the allow list (`AKIAIOSFODNN7EXAMPLE`,
`wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, the 16 gcp-api-key examples gitleaks allows at line 612).

GitHub's 2021 token formats carry a CRC32 checksum (GitHub blog, 5 Apr 2021); it is not checked, because one
misread character breaks it and the cover needs only the place.

### 4.2 Secrets inside links (on the URL view; the cover is the secret part only)

| Rule | Pattern | Score |
|---|---|---|
| slack-webhook | `(?:https?://)?hooks\.slack\.com/(?:services\|workflows\|triggers)/([A-Za-z0-9+/_-]{20,})` (gitleaks slack-webhook-url, 3032) | 0.98 |
| discord-webhook | `discord(?:app)?\.com/api(?:/v\d+)?/webhooks/(\d{5,}/[A-Za-z0-9_-]{20,})` | 0.98 |
| teams-webhook | `webhook\.office\.com/webhookb2/([^\s"'<>]{20,})` (gitleaks microsoft-teams-webhook, 2608) | 0.98 |
| google-chat-webhook | `chat\.googleapis\.com/v1/spaces/[^\s/]+/messages\?([^\s"'<>]+)` | 0.98 |
| url-userinfo | `\b[a-z][a-z0-9+.-]*://[^\s/:@]+:([^\s/@]{3,})@` (the password of `postgres://user:pw@host`; not a placeholder `pass, password, user, x…`) | 0.97 |
| url-user-token | `\b[a-z][a-z0-9+.-]*://([A-Za-z0-9]{16,})@` (a DSN key: `https://<key>@o4507.ingest.sentry.io/…`) | 0.90 |
| url-param | `[?&#](name)=([^&#\s"'<>]{8,})` with name ∈ access_token, id_token, refresh_token, token, auth, auth_token, authorization, api_key, apikey, key, secret, client_secret, password, passwd, pwd, pass, sig, signature, code, session, sessionid, sid, jwt, otp, reset_token, invite, magic, X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token, X-Goog-Signature, X-Goog-Credential, ticket, oobCode, login_token, invite_token, auth_key, secret_key, private_token, access_key, state_token (case-insensitive). `code`, `key`, `sid`, `session` need ≥ 16 characters or a digit; ISO dates are skipped; Azure SAS `sv, se, sp, st` are not secret, `sig` is | 0.92 |
| path-token | `/(?:invite\|invitation\|reset\|reset-password\|magic\|verify\|confirm\|activate\|join\|share\|s)/(token)` where the token is ≥ 16 of `[A-Za-z0-9_-]` holding a digit and a letter | 0.90 |
| cli-secret-flag | `--password, --passwd, --pass, --token, --secret, --client-secret, --api-key, --apikey, --access-key, --secret-key, --auth-token` followed by a value of ≥ 8 with entropy ≥ 3; `-p` only on a line naming `login, mysql, mysqladmin, mariadb, sshpass, psql, mongo(sh), redis-cli, smbclient, rdesktop, xfreerdp` (`tsc -p tsconfig.web.json` and `docker -p 8080:80` are not secrets); never a port, a file name, `$VAR` or `%VAR%` | 0.85 |

### 4.3 Strong labels (decision 2: 0.75, Check)

- **Assignments** (code and config text; gitleaks generic-api-key, line 638):
  `(?:^|[^\p{L}\p{N}_])((?:[\w.-]{0,30}?)(?:api[_.-]?key|apikey|secret|token|passw(?:or)?d|pwd|credential|creds|auth|access[_.-]?key|private[_.-]?key|client[_.-]?secret))(?:[ \t\w.-]{0,20})["']?\s{0,3}(?:=|:|:=|=>|,|\|\|)\s{0,3}["'`]?([A-Za-z0-9_.=+/~-]{8,150})["'`]?`
  The value needs Shannon entropy ≥ 3.0 bits a character (gitleaks uses 3.5 for this rule; 3.0 keeps the
  32-hex keys) and is skipped when it is letters only (gitleaks' own allow pattern `^[a-zA-Z_.-]+$`),
  `true/false/null/none/undefined/string/…`, a placeholder (`<…>`, `${…}`, `{{…}}`, `your_…_here`, `changeme`,
  `example`, `dummy`, `test`, `sample`, `redacted`, `xxx`, `***`), code that reads the secret from elsewhere
  (`os.environ[…]`, `process.env.X`, `getenv(…)`, `config.x.y`, a call or index, a regex literal), a URL scheme
  followed by `://`, a path (`//…`, `/a/…`), or an env assignment (`SENTRY_DSN=https`).
- **UI labels**: `API key, secret key, client secret, access token, auth token, refresh token, bearer,
  personal access token, token, signing secret, webhook secret, private key, secret access key, access key,
  app secret, secret, credential(s), clave de API, এপিআই কী, टोकन` with a separator then a value of ≥ 12 with
  a letter, a digit and entropy ≥ 3; or a short label line above (≤ 4 words, ≤ 40 characters; also the short
  key labels `key, setup key, secret key, this key, type this key, token, read token, write token`) or a label
  box to the left on the row. The value must have no space, not be a URL, a file name
  (`k8s/payments-secret.yaml`) or a Wi-Fi type (`WPA2-Personal`).
- **Authenticator setup keys** under or beside such a label: `^[A-Z2-7]{4}(?: [A-Z2-7]{4}){3,}$` or
  `^[A-Z2-7]{16,}$` (base32) → 0.95.

### 4.4 Unlabelled random-looking strings (off by default)

`(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-])`, two character classes, entropy ≥ 4.0 → 0.55.
Measured (section 11.2): it fired on 1,940 of 5,000 synthetic commit hashes, UUIDs, `sha256:`/`sha512-` digests
and build ids (38.8 %), 84 times in Flown's docs, 62 in its source and 107 in its tests: 2,193 extra hits in
368,134 lines, of the same order as the 2,766 the first version measured. It stays off; when on, only Check.

---

## 5. Passwords, PINs, codes

### 5.1 Passwords

Labels: `password(s), passwd, pwd, pass, passcode, passphrase, pass phrase, contraseña, clave, পাসওয়ার্ড
(both spellings of য়), গোপন নম্বর, पासवर्ड, कूटशब्द, network security key, Wi-Fi password, WPA(2) key,
pre-shared key, PSK`, matched on the label view (`PASSW0RD`).

| Rule | Value | Score |
|---|---|---|
| password-labelled | after the label: a separator (`: = ： #`, `is/was/es/হলো/হচ্ছে/है`, quotes around either side: `"PASSWORD":"Hn8$wQ4z-Lk2"`), or up to five words then `is` (`PIN for the shared phone is 2580`), or nothing when the line is exactly `<label> <value>`; value `\S{4,64}` with trailing `, ; ) ] } ' " \`` removed | 0.90 |
| password-below-label | the line is one token under a short label line | 0.90 |
| password beside | a label box to the left on the row, other boxes between allowed | 0.90 |
| `pass` | only at the start of the line or after a user field (`user: admin  pass: hunter2x`), and only with `:` or `=` | 0.90 |
| password-dots (off) | `•{4,}` (any bullet-like dot) after or under a label | 0.60 |
| not a password | the line says `forgot, reset, change, show, hide, confirm your, enter (your), manager, must, at least, strength, requirement(s), policy, incorrect, wrong, invalid, expired, update, remember`; placeholders; code (`os.environ[…]`, `job.pass`, CamelCase identifiers after `pass:`); punctuation only; `WPA2-Personal, WEP, AES, TKIP, Open, None, Hide, Show, Copy, Edit, Change, Reveal` | — |

### 5.2 PINs and one-time codes

| Rule | When | Score |
|---|---|---|
| pin-labelled | the label `PIN`, `পিন`, `पिन` or `NIP` (case as written: "Pin to taskbar" is not a label) then `\d{4,8}` | 0.90 |
| code-labelled | a code label (`code, OTP, one-time code/password/passcode, 2FA, two-factor, verification, security code, authentication code, confirmation code, login code, sign-in code, código, কোড, ওটিপি, যাচাই, कोड, ओटीपी, सत्यापन`) then `(?:[A-Z]-)?(?:\d{3,4}[ -]\d{3,4}\|\d{4,8})` or `[A-Z0-9]{4}-[A-Z0-9]{4}` (device and pairing codes `WDJB-MJ7T`) | 0.90 (alphanumeric 0.85) |
| value first | `(?:[A-Z]-)?\d{4,8} (is\|es\|হলো\|है) (your\|the\|tu\|su\|আপনার\|आपका) …` with a code label in the next 48 characters (`G-482913 is your Google verification code`) | 0.90 |
| code under a sentence | the whole line is a code value and one of the two lines above names a code, even in a sentence (`Use this code to finish signing in.` above `739204`; `Confirmation code from your card reader` above `90218744`; `3. Enter the 6-digit code` above `204 617`) | 0.90 |
| recovery-code | lines in a block that starts with `recovery code(s), backup code(s), recovery phrase, seed phrase, secret recovery phrase, mnemonic, recovery key` (up to 8 lines below, past at most one sentence), when ≥ 60 % of the line's tokens are code-shaped: each `[A-Za-z0-9]{3,6}[- ][A-Za-z0-9]{3,6}` or `[A-Za-z0-9]{6,12}` with a digit; boxes on the same row as a block box count too (codes in a grid) | 0.90 |
| not a code | `CODE_NOT` on the line or the label line: `zip, postal, post, country, area, dial(ling), error, status, exit, return, source, promo(tional), discount, coupon, gift, referral, QR, bar, colo(u)r, hex, HTTP, language, currency, airport, product, item, SKU, tax, reason, response, event, key code, code of conduct/review/block/editor/snippet/base/signing, VS Code, Visual Studio Code, Claude Code, code 2024`; a year `19xx/20xx`; algorithm names (`SHA-256`, `AES-256`, `UTF-8`, `RFC 6238`…) | — |

Authenticator apps show codes with no label (`204 617` under an account name). Without a label they are not
found; the design should say so in the "what Find does not see" line rather than guess from font size.

---

## 6. Row, column and frame rules

| Rule | How |
|---|---|
| beside | For each box, the ≤ 3 nearest boxes to its left whose vertical centre is within 0.6 line heights (a left box may overlap this one by up to 0.6 line heights: OCR boxes overlap). The first of them (nearest first) that is a label box (≤ 6 words, matches a label, or ends in `secret/key/token/password… =`) makes this box its value. |
| under | The line above is a short label line: ≤ 40 characters, ≤ 4 words, the label taking all but ≤ 10 other characters (`*`, `:`, `(required)` allowed). The value is the whole line: one token, or for IDs and codes up to 30 characters with ≥ 50 % digits. |
| code under a sentence | Section 5.2: two lines above, any length. |
| recovery block and grid | Section 5.2. |
| PEM block | From a private-key BEGIN line, every line below in the same column up to the END line (`PEM_END`, dashes optional), at most 60 lines, is covered across the block's full width (OCR drops the leading dashes, so the BEGIN and END boxes are narrower than the text). If the END line is not read, cover to the bottom of the text region as a lost area, and also when the reader returned no lines between BEGIN and END (the small model did this on one frame). |
| continuation | A key hit that runs to the end of a line whose right edge is within 1.2 line heights of its block's right edge continues on the next line when that line starts within 2.5 line heights of the same left edge with `[A-Za-z0-9_+/=.-]{4,}` that is not a plain word (`Export`, `smtp`, `Ticket` are words). |
| wrap join | A line ending in a full-width token (as above) and the next line's first token are joined with no space; when the joined string matches a strong rule that neither part matches alone, both parts are covered. |

---

## 7. Names the user lists

Matching on screen is visual, not phonetic: OCR confuses shapes (`rn`/`m`, `cl`/`d`, `vv`/`w`, `1`/`l`/`i`,
`0`/`o`, `5`/`s`, `8`/`b`, `6`/`g`), not sounds.

1. Fold both sides: NFKD, drop marks, lower case, then `rn→m vv→w cl→d 0→o [1|!]→l 5→s 8→b 6→g i→l`.
2. An entry is a phrase; `*` at either end is a wildcard (`Acme*` matches `AcmeCorp`). Spaces are optional
   (`RiadHasan`, OCR joins words), up to 4 OCR words a match.
3. Damerau–Levenshtein distance between the folded entry (spaces removed) and the folded window: 0 edits for
   ≤ 4 characters, 1 for 5–8, 2 for ≥ 9; the window's length may differ by at most that many.
4. Where windows overlap, the smallest distance wins (`as Riad Hasan` loses to `Riad Hasan`).
5. Exact after folding → 0.97 (auto); within tolerance → 0.80 (Check). One word of a listed full name alone is
   not a match (`Hasan Ali` for "Riad Hasan"); the user lists each form they want hidden.
6. The never-hide list (product names) is checked after folding and removes a hit whose own text equals it.

Speech: section 9.5.

---

## 8. QR codes (classed in the reader; the payload is never printed, logged or returned)

The helper decodes with `rqrr` (0.11.0, 2 Sep 2026, licence `(MIT OR Apache-2.0) AND ISC`, ISC from quirc) and
returns only the class and the code's quad.

| Class | Payload | Score |
|---|---|---|
| secret | `otpauth://`, `otpauth-migration://` (authenticator secrets and exports); `WIFI:` with a `P:` field; any strong rule of section 4 or a secret link parameter inside the payload; login and pairing codes (`https://discord.com/ra/…`, `https://s.team/q/…`, WhatsApp Web's `n@…,…,…` form) | 0.99 |
| personal | `BEGIN:VCARD`, `MECARD:`, `mailto:`, `tel:`, `sms:`, `geo:` | 0.90 |
| other | any other decoded payload, including plain links and wallet addresses | 0.60 |
| undecoded | three finder patterns found but no decode (a QR code half on screen can be read from another frame) | 0.60 |

---

## 9. Speech

### 9.1 What the transcript gives (code facts)

- `CaptionWord {text, start, end, estimated?, fromSound?, deleted?}`, `CaptionSegment {id, start, end, text,
  words?}`, `Transcript {language?, segments}` (`src/shared/types.ts:316-360`).
- Bleeps: `Bleep {id, start, end, word, sound, auto?}` where `word` is "the word as matched, lower case, at most
  40 characters (Review titles, masking checks)" (`types.ts:873-882`). A private bleep must not store the
  secret there: store a kind marker and keep the matching in memory.
- `maskWord` keeps the first letter (`"f***"`, `src/shared/captions/cleanup.ts:842`). A private mask must hide
  every character (`••••`).
- `maskedSegments` returns the caption unmasked when its words and its text do not line up one to one
  (`cleanup.ts:896`, `if (times.length !== texts.length) return seg`). For private bleeps this is a leak: mask
  by time, and when the words cannot be lined up, mask the whole caption text from the first to the last word
  that overlaps the bleep (or the whole caption). This is what the first version's "every word under a private
  bleep is masked, even when the caption's words and times don't line up" fixed.
- `parseEnglish` and the Bangla/Hindi parser refuse numbers said one after the other ("Two numbers said one
  after the other: none", `numbers.ts:179, 235`), so a digit-stream reader is needed; `numberData.ts` already
  holds the CLDR 49 Bangla and Hindi words for 0–99 (Unicode License v3) and `asciiDigits` (`numbers.ts:22`)
  converts five digit scripts.
- Bangla text must be compared in NFC, and stripped of punctuation and symbols only (`[\p{P}\p{S}]`, as
  `bareWord` does, `numbers.ts:42-49`). Stripping "anything not a letter or digit" removes Bangla vowel signs
  and the nukta (`\p{M}`) and turns নয় into নয, হলো into হল (the prototype had this bug; three Bangla vectors
  failed until it was fixed). য় (U+09DF), ড় and ঢ় are composition exclusions: NFC keeps them as two code points,
  so every word list must be normalised with the same NFC at build time.

### 9.2 The digit stream

Flatten all words of all segments in time order (segment boundaries and full stops do not end a run). Each
word gives digits:

| Language | Words |
|---|---|
| digits | any token of digits (all five scripts), `4111-1111`, `4111.` (punctuation dropped); a version `44.9.3` gives none |
| English | zero, oh/o (only inside a run), nought, nil, one … nine; ten … nineteen (two digits); twenty … ninety (`twenty five` → 25, `forty-two` → 42, a lone tens word → x0) |
| repeat | double, triple (`double five` → 55); ডাবল, ট্রিপল; doble; डबल, ट्रिपल |
| Bangla | শূন্য 0, এক 1, দুই/দু 2, তিন 3, চার 4, পাঁচ 5, ছয়/ছ 6, সাত 7, আট 8, নয় 9 (from numberData.ts for 10–99) |
| Bangla loan words (English digits in Bangla script, common in Bangladeshi speech and in Bangla Whisper output) | জিরো 0, ওয়ান 1, টু 2, থ্রি 3, ফোর 4, ফাইভ 5, সিক্স 6, সেভেন 7, এইট 8, নাইন 9 |
| Spanish | cero, uno/una, dos, tres, cuatro, cinco, seis, siete, ocho, nueve |
| Hindi | शून्य, एक, दो, तीन, चार, पांच/पाँच, छह/छः, सात, आठ, नौ |
| fillers kept inside a run | um, uh, erm, then, dash, hyphen, space, comma, is, উম, আর, ড্যাশ, y, guion/guión |

A run ends at a pause over **2.0 s** between words, or at any other word. `and` ends a run: with `and` as a
filler, "content clicks at 400, 300 and 1500, 800" became the Luhn-valid 13-digit card `4003001500800`.

### 9.3 Spoken rules (on runs; the label context is the 12 words or 10 s before the run)

| Kind | Rule |
|---|---|
| card | 13–19 digits with Luhn + IIN (no label needed), or 13–19 digits with a card word (card, credit, debit, visa, mastercard, amex, কার্ড, tarjeta, कार्ड). Finding 10: `4917 6123 4567 eight nine zero four` is one run |
| code | 4–8 digits with a code word (code, otp, verification, passcode, pin, কোড, ওটিপি, পিন, código, कोड, ओटीपी, पिन), said as one 4–8 digit number, as ≥ 4 single digits, or as 3–4-digit groups; never a year or a version |
| phone | 7–15 digits with a phone word (phone, number, call, mobile, cell, whatsapp, ফোন, মোবাইল, নম্বর, নাম্বার, teléfono, número, फ़ोन, फोन, नंबर, मोबाइल), or a Bangladeshi mobile `01[3-9]\d{8}` / `8801[3-9]\d{8}` with no label. The builder should also run the libphonenumber VALID check of section 3.3 on the run for the user's regions |
| id | 6–20 digits with an ID word (social security, ssn, account, routing, passport, licence, national insurance, aadhaar, nid, অ্যাকাউন্ট, হিসাব, পাসপোর্ট, এনআইডি, cuenta, खाता, आधार) |
| password | a password word (password, passphrase, passcode, পাসওয়ার্ড, contraseña, पासवर्ड) followed at once by `is, was, =, :, হলো, হল, হচ্ছে, es, है, it's`; then up to 6 words, ending at a pause over 1.0 s or a sentence end (`the password is hunter two exclamation.`). "it skips password boxes" gives nothing |

Measured on Flown's docs read as if spoken (455,764 words, 0.4 s a word): 8 hits, 0.18 per 10,000 words
(section 11.3). A 20-minute talk is about 3,000 words.

### 9.4 Emails said aloud

`<1–4 words> (at | at the rate | অ্যাট | এট | arroba | एट) <domain word> (dot | ডট | punto | डॉट) <tld word>
[(dot) <tld word>]`, tld words `com, net, org, io, co, edu, gov, bd, uk, in, es, ai, dev, me, info, কম, নেট, অর্গ`.
"at the rate" is how many South Asian speakers say @. The words before `at` stop at `is, me, my, email, mail,
at, to, write, it's`. Whisper often writes the address as one token (`jsmith@gmail.com`): run the screen
rules (sections 2 and 4) on every caption's text too.

### 9.5 Names said aloud

Transcripts misspell names phonetically (`Shawn`/`Sean`), so speech uses double metaphone: a caption word
matches a listed word when their primary or secondary codes are equal and their Damerau–Levenshtein distance
is ≤ 2 (`double-metaphone` 2.0.1, section 10.2). Double metaphone is defined for Latin letters only. For a
Bangla-script transcript, compare Bangla to a Bangla entry by the edit distance of their NFC forms; for a Latin
entry, transliterate the Bangla word with a fixed table first. Both need the native Bangla review of decision 8.

### 9.6 Bleeping

- A private bleep spans the first word's start − 0.05 s to the last word's end + 0.05 s (0.15 s for estimated
  times), the same widening as `Bleep` (`types.ts:875`).
- Every word under it is masked completely in the captions, in every translation (masked whole until
  translated again after Find), in chapter names, the publishing pack, the guide and every AI request
  (decision 7). The mask is by time (9.1), never by the stored word.
- Sound: both `tone` and `silence` already mute the word through `bleepGains` (`cleanup.ts:979`).

---

## 10. Libraries and data

### 10.1 libphonenumber-js

- Version: **1.13.16** (published 10 Nov 2026 08:11 UTC; 14 days old on 24 Nov 2026). 1.13.17 (19 Nov 2026) is
  the latest; 1.13.15 (8 Oct 2026) is the newest one already two weeks old today. Tarball
  `https://registry.npmjs.org/libphonenumber-js/-/libphonenumber-js-1.13.16.tgz`, 1,908,294 bytes, SHA-256
  `5cc6aa79db25ac97a730d110f47a1ed35cdeb8c53df48bed03b85d73a5205ba5`, npm integrity
  `sha512-tIOCM9yx2Go6d5/ZANe0K+G4AZek1Ymx81HxQpf19Sri4zMP95eQbKdnUGHAvFQ4nx0PeLhFqvAfisTADXj3tQ==` (checked
  against the registry). No dependencies.
- Licence: **MIT** (Copyright (c) 2016 @catamphetamine) for the code; the metadata is generated from Google's
  libphonenumber `PhoneNumberMetadata.xml`, **Apache-2.0**; the package ships both `LICENSE` and
  `LICENSE.Apache` and an `AUTHORS` file (Google Inc., Vonage Holdings Corp., …). Both texts go into the notice.
- Sizes: `metadata.min.json` 83,298 B (18,946 gzip, 16,432 brotli 11); `metadata.max.json` 156,639 B (38,907 gzip,
  34,054 brotli 11); `metadata.mobile.json` 98,793 B. The prebuilt `bundle/libphonenumber-min.js` is 178,137 B
  (35,130 brotli) and `-max.js` 251,478 B (52,624 brotli).
- **Use max**: it is the only one with per-type patterns, so it can say "valid" and "mobile" (needed by 3.3);
  the extra 73 KB is nothing in an Electron app. Min's general pattern accepts 80 % of random US 10-digit
  strings against 31 % for max.
- **Vendoring without `npm install`** (the precedent is `scripts/build-emoji-data.mjs`, which pins tarballs by
  SHA-256 and writes GENERATED files with a `--check` mode, and `resources/notices/34-twitter-text.txt` for code
  written into Flown):
  1. A script downloads the pinned tarball, checks the SHA-512 integrity and SHA-256 above, and copies the
     ES modules reached from `es6/findPhoneNumbersInText.js`, `es6/parsePhoneNumber.js`,
     `es6/isValidPhoneNumber.js` and `metadata.max.json.js`: **54 files, 378,277 bytes** (304,936 with min). Going
     through `core/index.js` or `max/exports/*` instead pulls 76 files (516,302 bytes) because the index
     re-exports AsYouType. The import walk found no bare imports.
  2. Drop the `//# sourceMappingURL=` lines (the maps are not copied), keep each file's bytes otherwise.
  3. Write them under `src/shared/privacy/vendor/libphonenumber/` with a header naming the version, tarball and
     hashes; `--check` compares.
  4. Add `resources/notices/3x-libphonenumber-js.txt` with the MIT text, the Apache-2.0 text and the AUTHORS
     list, and list it where `scripts/notices.mjs` lists hand-written notices (its `BUNDLED` array,
     `scripts/notices.mjs:32`, covers npm packages only).
  5. Convert Bengali and Devanagari digits before calling it (3.3).

### 10.2 double-metaphone

- `double-metaphone` **2.0.1** (2 Nov 2022), **MIT** (Copyright (c) 2014 Titus Wormer). Tarball 8,588 B, SHA-256
  `f069e40def102dd0b6c661040a6b72c88ec5c78900204716df4218d40249c1c3`, integrity
  `sha512-oHqGfNo2bG/VTZSGFz98TWpyv3WD+d9TDOxwAY8L+zqwm4sGawNvEynegjPU+4HowE4HnIXSYAq0lst2YJgfzA==`.
- One ES module `index.js`, 24,368 B (3,994 brotli), no imports, `export function doubleMetaphone(value)`
  returning `[primary, secondary]`. Vendor it the same way, with a notice.

### 10.3 gitleaks rules

Copied as translated regular expressions (section 4), so the MIT notice (Copyright (c) 2019 Zachary Rice) goes
into `resources/notices/`, with the version (v8.30.1) and the file's SHA-256.

### 10.4 Already in the repository

The TLD lists (twitter-text 3.1.0, Apache-2.0), the CLDR 49 number words (Unicode License v3), `asciiDigits`,
and `redact.ts`'s secret patterns (`src/shared/diagnostics/redact.ts:37-52`), which the log redaction already
uses and which the detector's tables extend.

---

## 11. Evaluation

### 11.1 Vectors

`vectors.json`: 178 screen and 25 speech vectors, every rule with positives and negatives, including every
shape the corpora and the OCR reads surfaced. All 203 pass with the prototype. Token-shaped values are seeded
placeholders (`«=ghp_|A36»`, seed 20261123), so the file holds no string that secret scanning or push protection
would flag; the builder's test expands them the same way (`scripts/runVectors.mjs`).

### 11.2 False hits on text with nothing planted (default rules)

| Corpus | Lines | Hits (score ≥ 0.5) | Per 10,000 lines | What they were |
|---|---|---|---|---|
| Flown's English UI catalogue | 5,502 | 0 | 0 | — |
| docs/**/*.md | 35,922 | 5 | 1.4 | 4 sample emails (`anna.li@acme.de`), 1 sample key written in a doc (`sk-e2e-polish-0001`) |
| src/**/*.ts(x) (without generated data files) | 169,896 | 13 | 0.8 | 11 real emails in font licence headers, 1 path after `api_key`, 1 `password: next` in a comment |
| tests/**/*.ts | 147,814 | 160 | 10.8 | almost all the repository's own fake keys, webhooks and `user:pw@` links, which should be covered (117 emails, many the `pw@host` of credential links); 1 `+ 1248 - 100 - 1700` |
| 5,000 synthetic hashes, UUIDs, digests, build ids | 5,000 | 0 | 0 | — |
| 5,000 synthetic order, invoice, total, ticket, `Ref dddd dddd dddd dddd` lines | 5,000 | 26 | 52 | Luhn-valid random reference numbers, all Check (0.60) |

The first draft of the rules gave 97 hits on the docs and 411 on the numbers set; sections 3.1, 3.3 and 5 hold
the gates that removed them. With random strings on: +84 (docs), +62 (src), +107 (tests), +1,940 (hashes).

### 11.3 Speech false hits

Docs read as speech: 455,764 words, 8 hits (0.18 per 10,000 words): 3 IDs, 1 card ("nineteen ninety nine",
"twenty twenty four" … in a list of examples), 2 codes, 2 phones, all from numbers in technical prose.

### 11.4 End to end on real OCR reads of the evaluation set

The OCR researcher's 24 frames (1920×1080 at 100/125/150 % scale, dark and light, 510 planted items, 239 to cover
of which 233 are text and 6 QR codes, 271 that must stay visible: ordinary text, addresses, dots, random
strings) and that researcher's PP-OCRv6 reads made on one thread (`ocr/work/reads-quiet/*.json`, generator
`scripts/privacy/make-eval-set.mjs`, Chromium 157.0.8103.78). Found = hits cover
≥ 50 % of the item; covered = padded hits cover all of it.

| Reads | Found | Covered | Visible items touched | Stray hits |
|---|---|---|---|---|
| tiny (the rules were tuned on these) | 233/233 (100 %) | 227 (97.4 %) | 1/271 | 1 (a publishable `pk_live_` key, Check) |
| careful, careful-narrow | 233 (100 %) | 227 (97.4 %) | 1 | 1 |
| tinydet-smallrec | 233 (100 %) | 228 (97.9 %) | 1 | 1 |
| small (held out) | 226 (97.0 %) | 221 (94.8 %) | 5 | 1 |

Before the row, column and OCR-tolerance rules the tiny reads gave 160 found (68.7 %), 150 covered (64.4 %).
The partly covered items are PEM BEGIN/END lines and wrapped JWTs at 88–99 %: OCR dropped leading dashes or
the last characters fell just outside the box, which the block-width and continuation rules of section 6 are
for. The small model's 7 misses are lines it did not return (a PEM body, a line of recovery codes) and a card
and an IBAN it misread, which the merged-group and repair rules then caught.

---

## 12. Why only a solid fill

| Evidence | What it shows |
|---|---|
| Hill, Zhou, Saul, Shacham, "On the (In)effectiveness of Mosaicing and Blurring as Tools for Document Redaction", PoPETs 2016(4):403–417 | Hidden Markov models recover mosaiced and blurred text, "both short and indefinitely long"; seven-digit account numbers in MICR font are recovered over a wide range of grid sizes; "mosaicing and blurring … are not viable approaches for text redaction". |
| McPherson, Shokri, Shmatikov, "Defeating Image Obfuscation with Deep Learning", arXiv 1609.00408 (2016) | Standard image recognition defeats mosaicing (57 % on FaceScrub against 16×16 mosaics, 0.19 % chance) and blur. |
| Depix (Sipke Mellema, 2020) | Recovers passwords from linear-box-pixelated screenshots by matching blocks against a rendered De Bruijn sequence. |
| Unredacter (Bishop Fox, Dan Petro, Feb 2022, GPL-3.0) | Brute-forces pixelated text by rendering guesses; "Never, ever, ever use pixelation for redacting text"; use opaque bars. |
| Positive Security, "Recovering redacted information from pixelated videos" (25 Jan 2022) | Camera motion shifts the mosaic grid over the content; stabilising and overlaying frames read a pixelated IBAN back. |
| Jeff Geerling, "It's easier than ever to de-censor videos" (15 Apr 2025) | A pixelated Finder window was read by three viewers within a day because the window moved; he now uses "a pure-color mask". |
| Reduct "Secure Blur" (Oct 2023) | Only replacing the area with pixels computed from outside it is safe; ordinary blur and mosaic "are often reversible". |
| Flown's own first version | Brute force on Flown's blur and pixelate read codes back (decision 3). |

Screen recordings are the worst case for blur and mosaic: text scrolls under the effect, every frame samples
it at a new phase, and the font is known. A solid cover filled into the screen picture after the crop and
grade, and again on the output (decision 3), leaves nothing to sample.

---

## 13. Competitors and complaints

| Product | What it does | Source |
|---|---|---|
| Snagit (TechSmith) Smart Redact | Images only. Detects addresses, card numbers, dates, emails, faces, IP addresses, phone numbers, SSNs, URLs; per-type toggles; blur, pixelate or black bars; ABBYY OCR and OpenCV on Windows, Apple OCR on Mac; Dec 2025 update finds similar content across screenshots | techsmith.com Smart Redact page and FAQ |
| Camtasia 2025 | No automatic redaction; manual blur/mask shapes that must be animated to follow moving content | TechSmith tutorials, community posts |
| Screen Studio (Mac) | 3.1 (Mar 2025) added manual masks; a user asked for scroll-aware masks because "that rectangle stays in the same position on the screen instead of following the element" (8 Oct 2025, 13 votes). **4.0/4.1 (26 Oct 2026) "Hide sensitive data"**: emails, phone numbers, card numbers and keys covered automatically anywhere in a recording, user terms (names) added, covers "track text as you scroll and type", on-device; faces blurred | hub.screen.studio; AlternativeTo news 2026-10 |
| Loom | Manual blur in the Chrome extension, before or while recording, Business/Enterprise; cannot blur after recording | support.atlassian.com/loom |
| Tella | Manual blur; an agent places blurs when told what and when; "a blur is a fixed area and doesn't follow moving content" | tella.com |
| Descript | "Glass Blur" effect for part of the screen (shipped after a feature request); requests for "Blur Personal Info" merged | feedback.descript.com |
| Zight | Post-recording redaction of MP4s with "permanent opaque masks": emails, phones, card numbers, SSNs, AWS key IDs, selected API keys; reviewer told to check first and last frames as content scrolls | zight.com/features/video-blur |
| Scribe Smart Blur (4 Sep 2026) | Screenshots only; emails, numbers, common names, long text, form fields, table rows, images; blur | scribe.com |
| Supademo, Tango | Smart/Batch blur of emails, numbers, currency on capture; blur | docs.supademo.com, tango.us |
| Premiere Pro | No automatic redaction; AI object mask + tracking, one subject at a time; an open request (Jun 2025) for out-of-the-box face blur | helpx.adobe.com, community.adobe.com |
| DaVinci Resolve 20 | Magic Mask 2 / IntelliTrack follow objects; text and plates are masked and tracked by hand | Blackmagic, forums |

What users complain about: masks that do not follow scrolling (Screen Studio, Camtasia, Tella), blur that can be
undone or is weak (Screen Studio's own guide recommends solid masks for keys), no way to blur after recording
(Loom), and hours spent blurring keys by hand. Flown's position: on this PC, video not just screenshots, solid
covers, covers that follow, speech too, and a review list.

---

## 14. Review findings this research addresses

| Finding | Rule here |
|---|---|
| 10 digits said before number words across sentences | 9.2, 9.3; vectors `say-card-mixed-words`, `say-card-sentences`, `say-card-across-segments` |
| 11 matcher built from the padded span | Section 0 (own span) |
| 13 tidy captions kept real words under private bleeps | 9.1, 9.6 (mask by time, whole caption when words do not line up) |
| 22 a line box rounded past the frame edge | Section 0 (clip to the frame) |
| 24 leading-star names written to logs | Names and found text never go to logs; `Bleep.word` holds a kind marker (9.1) |
| 5 stacked toasts | Not a text rule; noted for the scan |

## 15. Open items

- The phone check on spoken runs should call the same VALID/POSSIBLE code as the screen (the prototype uses
  labels and the BD mobile shape only).
- Authenticator codes with no label, and passwords shown without a label, are not found; say so in the panel.
- The evaluation set is English and Latin script; Bangla on screen is not read in this wave, and the Bangla
  speech word lists need the native review (decision 8).
- The prototype's prefix view loops over 50 prefixes at each token start; build one matcher.
- Decide whether `pk_live_` publishable keys stay Check or are dropped; they are public by design.
