# Search every recording (F-18)

Find a moment across the whole library from Home: type a few words and see the recordings, and the
exact moments, where they were said (captions), shown on screen (a title card, a chapter, a text
overlay) or written (speaker notes, the recording's name, the imported file's name). Enter opens
the recording in the editor at that moment.

Everything is local: no server, no AI key, nothing leaves the PC. The index is a small JSON file in
userData, built in the main process in the background and kept up to date when a project is saved.

Later (designed in §12, not built now): on-screen text read with Windows OCR, and search by meaning
with a small local model.

## 1. What the user gets

- A search box under the head of **Recent recordings** on Home: `Search recordings` with a
  magnifier, and `Ctrl+F` anywhere on Home puts the cursor in it (selecting what is there), unless a
  dialog is open over Home.
- As they type (150 ms after the last key), the recording grid is replaced by results, grouped by
  recording: the recording's name, date and length, then up to 4 moments, each with a time
  (`1:23`), where the words were found (`Said`, `Title`, `Chapter`, `On screen`, `Notes`, `Name`,
  `File`) and a one-line snippet with the matched words in bold. `3 more moments` is a button that
  shows the rest (up to 50).
- `↓`/`↑` move through the rows (each recording's heading, its moments, its "more" row), `Enter`
  opens the recording at the moment (the first row when none is active; never while an input method
  is composing), `Escape` clears the box (a second Escape leaves it). `Home`/`End` stay with the
  text, as in any text box.
  The list is an ARIA `listbox` driven from the input (`aria-activedescendant`), the pattern of a
  combobox: focus stays in the box, a screen reader reads each moment as one sentence ("Said at
  1 minute 23 seconds: open the settings page. In Product demo, 12 March"), and a polite live region
  says "4 recordings found" (or "No recordings match "foo"").
- Typo tolerant: `setings` finds "settings", `recrod` finds "record". Prefix matching: `sett` finds
  "settings" while typing. Every word must be found in the recording (AND), anywhere in it; moments
  that hold more of the words come first.
- Works in every language Flown captions: Latin, Cyrillic and Greek letters ignore case and accents
  (`cafe` finds "Café"); Bangla, Hindi and other Indic scripts keep their vowel signs (they are
  letters there, not accents) and match their decomposed and composed forms the same; Chinese,
  Japanese and Thai, written without spaces, are split into words by the system's word breaker.
  No stemming (§2.4).
- A moment that was cut from the video is still found (the words are in the recording) and says
  `Cut`; opening it goes to the next part that is kept, with the notice "That moment was cut from
  the video, so the editor is at the next part that is kept."
- While the index is first built (a new install with many recordings, or after an update that
  changes the index format) the results say "Still indexing your recordings (120 of 500)…" and fill
  in as it goes.

## 2. Decisions

### 2.1 Where the index lives and who builds it: the main process

| Option | For | Against |
| --- | --- | --- |
| **Main process, chunked** (chosen) | It reads the project folders already (projects.ts); one owner, so the editor's saves, deletes and Home's queries see one index; no new bundler entry | Must never block: work is split into slices of at most ~8 ms with `setImmediate` between them |
| Renderer (Home) | No IPC | Home is unmounted while the editor is open, and a save in the editor must update the index; the renderer cannot read the projects folder (sandboxed, by design) |
| `worker_threads` / `utilityProcess` | True parallelism | A new electron-vite entry in `electron.vite.config.ts` (not ours to change), a second copy of the index in memory or message passing for every query; the measured cost (§8) does not need it |

Queries are answered in the main process too: the vocabulary scan for typos is the costly part and
it needs the index. A query on 500 recordings takes about 5 ms (§8), well inside a frame.

### 2.2 What is indexed

Read from each project's `project.json` (`src/shared/types.ts`), never from media files:

| Kind (`SearchKind`) | From | Time | Weight |
| --- | --- | --- | --- |
| `name` | `Project.name` | none | 3 |
| `file` | `Project.source.fileName` (imported videos, read through `importedSource`) | none | 2 |
| `chapter` | `Project.chapters[].title` | `t` | 2.5 |
| `title` | `Project.titles[]`: `title` and `subtitle` | `start`–`end` | 2.5 |
| `text` | `Project.annotations[].text` (text on screen) | `start`–`end` | 1.5 |
| `said` | `Project.transcript.segments[]` (one unit per caption, its `text`) | `start`–`end` | 1 |
| `notes` | `Project.script.text`, one unit per non-empty line, at most 200 units | none | 0.8 |

Each is a **unit**: `{ kind, start, end, text }`. A unit's text is capped at 2,000 characters, a
project at 400,000 characters of text in all (a 10-hour recording's captions are about 350,000);
anything over is left out of the index, never an error.

Not indexed: words in shapes, brand-kit intro/outro cards come in through `titles` like any title;
image overlays (no text); the cursor and keystrokes (keystrokes never record which keys, by design).

### 2.3 How text becomes terms (`src/shared/search/normalize.ts`)

1. `NFKC` (full-width Latin, ligatures, compatibility forms; Bangla `য়` `ড়` `ঢ়` decompose to
   their nukta forms, as they are composition exclusions, so typed and pasted forms agree).
2. Lowercase (`toLowerCase`, locale-free: a Turkish `I` is folded like any other; acceptable).
3. Remove ZWJ, ZWNJ and soft hyphens (`U+200C`, `U+200D`, `U+00AD`): Bangla and Hindi users type
   them inconsistently.
4. Remove accents **only on Latin, Greek and Cyrillic letters**: decompose (`NFD`), drop a
   combining mark (`\p{M}`) when the letter it follows is in one of those scripts, compose again.
   A Bangla vowel sign (`া`, `ি`, `ু`, hasanta `্`) is a combining mark too, and is kept: removing
   it would make `কাল` (time) and `কল` (call) the same word.
5. Apostrophes inside a word are removed (`don't` → `dont`, `l’été` → `lete`).
6. Split into words: letters, marks and digits (`[\p{L}\p{M}\p{N}]+`). When a piece contains a
   character of a script written without spaces (Han, Hiragana, Katakana, Hangul is spaced and not
   included, Thai, Lao, Khmer, Myanmar), that piece goes through `Intl.Segmenter(…, 'word')`
   (ICU's dictionary word breaker, in Electron's full ICU) and its word-like segments are the
   terms. A query is split the same way, and prefix matching lets the first characters of a word
   find it.
7. Terms longer than 40 code points are cut to 40.

Every term keeps its character range in the original text, so snippets highlight the original
words (`highlightRanges`).

### 2.4 No stemming

Stemmers (Porter, Snowball) join "running" and "run", but they also join "university" and
"universe", break names and product words ("Teams" → "team"), and there is no good stemmer for
Bangla in a few kilobytes; the light Bangla stemmers in the literature strip suffixes such as
`-কে`, `-রা`, `-টি` and also eat word endings that are part of the root. Instead:

- **Prefix matching** covers the common case: `record` finds "recording", "recorded"; Bangla
  suffixes (`বাংলা` finds "বাংলায়", "বাংলার") are covered the same way.
- **Typos** are matched by edit distance (§2.5).

The cost is that `ran` does not find "run"; the user can type the word they remember.

### 2.5 Matching and typos

The query is normalised like the text (§2.3). Up to 8 terms are used (more are ignored, and the
results say nothing about it: 8 words is a phrase, not a search). Every term is matched against
the index's **vocabulary** (each distinct term once):

| Match | Quality | Rule |
| --- | --- | --- |
| exact | 1.0 | the same term |
| prefix | 0.75 + 0.2 × (query length ÷ term length) | the term starts with the query term (query term at least 1 code point; a 1-letter query term only matches by prefix in names, titles and chapters, see below) |
| typo | 0.55 (1 edit) / 0.4 (2 edits) | Damerau–Levenshtein distance (a swap counts as 1) between the query term and the term **or any prefix of it** ("prefix distance"); 1 edit allowed from 4 code points, 2 from 8; never for terms of digits |

A 1- or 2-code-point query term is matched only exactly and by prefix (no typos), and a 1-code-point
term by prefix only in `name`, `file`, `title` and `chapter` units, so typing the first letter
does not list every caption with a word starting with "a". Han characters are single code points,
so for them a 1-character term matches exactly in every unit.

The vocabulary scan uses the bounded distance with an early exit and skips terms whose length
cannot be within the allowed distance.

### 2.6 Ranking

For each recording:

- A **unit score** = Σ over query terms of (best match quality of the term in the unit) × the
  kind's weight, plus 0.5 × weight when the query's terms appear in the unit in the order typed
  next to each other (a phrase).
- The recording matches when **every** query term is matched in at least one of its units.
- **Recording score** = the best unit score + 0.25 × the number of other matching units (at most
  8 count), + 0.5 when the best unit holds every term.
- Recordings are sorted by score, then newest first. At most 50 recordings are returned.
- Moments of a recording are its matching units with a time or a kind of their own, sorted by the
  number of terms they hold, then their score, then time; at most 50 are returned and Home shows 4
  until "more" is pressed. `name` and `file` units are not listed as moments (the name is the
  recording's heading, with the matched words bold); a recording found only by its name shows
  "Found in the name".

### 2.7 Snippets

A moment's snippet is the unit's text around its first matched term: up to 60 characters before
and 120 after, cut on a word boundary with `…` at a cut end, never across a line break. Matched
terms are returned as ranges (`{ text, hit }` parts), never as HTML; the page renders them as text
in `<mark>`. This keeps any `<`, `&` in a caption inert.

### 2.8 The index file and its versions

`userData/search/index.json`, written atomically (`writeFileAtomicSync`, the way every state file
is), at most once every 3 seconds while changes come in, and once when the app quits:

```json
{
  "version": 1,
  "projects": {
    "rec-20261030-101500": {
      "stamp": "1730283300123.4:48211",
      "name": "Product demo",
      "createdAt": "2026-10-30T10:15:00.000Z",
      "duration": 312.4,
      "units": [["name", null, null, "Product demo"], ["said", 1.2, 3.9, "So the first thing…"]]
    }
  }
}
```

- `stamp` is `project.json`'s `mtimeMs:size`; a project whose stamp differs is read again.
- **Only text is stored, not the inverted index**: terms are made again when the file is loaded
  (§8: 0.4 s for 500 recordings, in slices). That keeps the file about the size of the text it
  holds and makes a change in tokenising (§2.3) need no rebuild.
- `version` is `SEARCH_INDEX_VERSION` (1). A missing file, unreadable JSON, a different version, or
  an entry that does not validate (wrong types, a unit kind not known) means that entry, or the
  whole file, is built again from the projects. Bump the version whenever **what is extracted**
  (§2.2) changes.
- The file is read with a 64 MB cap; anything bigger is ignored and rebuilt.

### 2.9 Keeping it current

| Event | What happens |
| --- | --- |
| App start | 4 s after the window opens, the index file is loaded, then **reconciled**: every project folder in `projectsRoot()` and the legacy roots is listed, `project.json` stat'ed; new or changed (stamp) ones are read and indexed, folders gone are dropped. One project per slice. |
| A project is saved (`saveProjectNow`, the editor's autosave and the closing save) | **One line** in `src/main/projectsIpc.ts` tells the index: `noteProjectSaved(project)`. It is debounced per project by 1.5 s (autosave runs every edit), and the entry is made from the project object in hand (no read), stamped with a fresh stat. |
| A recording finishes, a video is imported, a project is duplicated, recovered, deleted, or the Storage manager moves one to the Recycle Bin | Not hooked (those files belong to other teams). Home tells the index whenever its library list changes (`refreshSearch()`), and every query reconciles first when the last reconcile is older than 2 s; a reconcile with nothing changed costs one `readdir` and one `stat` per recording (about 4 ms for 500). |
| A query arrives while the first build runs | It is answered from what is indexed so far, with `status.state = 'building'`; Home asks again when `search:status` says more is ready (at most every 500 ms). |

All changes to the in-memory index run on one queue (a promise chain), so a reconcile and a save
note never interleave on one entry; a save note always wins over a read of an older file because
its stamp is taken after the write.

### 2.10 Opening at a moment

Home sets a **pending moment** (`src/renderer/src/search/openAt.ts`: `{ projectId, t, cut }`) and
calls its usual `onOpenProject(id)`; `App.tsx` is not changed. The editor's session (one additive
line in `Editor.tsx`: `useSearchMoment(store, player, showNotice)`) takes the pending moment once,
if it is for this project, and seeks:

- `t` inside a kept clip: `player.seek(t)`.
- `t` in a cut: the start of the next kept clip after `t` (else the end of the last one), and the
  notice above (`momentTarget` in `src/shared/search/moment.ts`, pure and tested).
- A moment with no time (notes, name): nothing is pending; the editor opens as it always does.

The pending moment is dropped when taken, when Home mounts again, and after 30 s, so it never
applies to a later open.

## 3. Data model

**No change to `project.json`, settings or any shared type.** Old projects load byte-for-byte
unchanged: the index only reads them. The index is its own file in userData; deleting it only
costs a rebuild.

New types live in `src/shared/search/types.ts` (§9).

## 4. Behaviour in numbers

| Thing | Value |
| --- | --- |
| Debounce of typing on Home | 150 ms |
| Longest query | 200 characters, 8 terms |
| Typos | 1 edit from 4 code points, 2 from 8 |
| Results | 50 recordings, 50 moments each; 4 moments shown per recording until "more" |
| Snippet | 60 characters before the first hit, 120 after |
| Save debounce | 1.5 s per project |
| Reconcile on query | when the last one is older than 2 s |
| Index write | at most every 3 s, and on quit |
| Start-up delay | 4 s after the main window opens |
| Slice | work until ~8 ms have passed, then `setImmediate`; one project is never split (13 ms for a 5-minute recording) |
| Text caps | 2,000 characters a unit, 400,000 a project, 200 notes paragraphs |
| Index file cap | 64 MB (read); `project.json` read cap 64 MB |

## 5. UI and copy

The search box sits on its own row under the head of **Recent recordings** (title and **Import
video** stay as they are, so the head is unchanged), at most 520 px wide. When the library is empty
it is not shown.

```
Recent recordings 12                                         [Import video]
[🔍 Search recordings                 ]
```

- Placeholder: `Search recordings`. `aria-label`: `Search recordings: words said, titles, chapters and notes`.
  Title (tooltip): `Search every recording (Ctrl+F)`.
- A clear button (`×`, `aria-label="Clear search"`) while there is text.
- While text is in the box, the grid is replaced by the results region:

```
3 recordings found                                           (live region, polite)

Product demo · Today, 10:15 · 5:12
  1:23  Said      …so the first thing you do is open **settings**.
  2:10  Title     **Settings** tour
  0:00  Chapter   **Settings**
  [2 more moments]

Onboarding call · 3 Oct 2026 · 41:02
  12:41 Said     …we changed the **settings** page last week…  Cut
```

- No match: `No recordings match "setings xyz".` and below, `Search looks in what was said
  (captions), titles, chapters, text on screen, speaker notes and names.`, followed by `Recordings
  without captions are found by their name, titles, chapters, text on screen and notes.` when at
  least one recording has no transcript.
- Building: `Still indexing your recordings (120 of 500)…` above the results.
- The index could not be read or written: results still come from memory; a warning goes to the
  log (no text), nothing is shown.
- Kind labels: `Said`, `Title`, `Chapter`, `On screen`, `Notes`, `File`. A cut moment adds a `Cut`
  tag after its snippet (`title="This part was cut from the video"`).
- The recording's heading row: its name (matched words marked), date and length, and
  `· Found in the name` when nothing else matched. Its screen reader text: `Open {name}. {date},
  {length in words} long.`; the "more" row: `Show {n} more moments. In {name}, {date}.`
- Screen reader text of a moment: `{Kind label} at {time in words}: {snippet}. In {name}, {date}.`
  ("Said at 1 minute 23 seconds: …"). A moment with no time: `{Kind label}: {snippet}. In …`.
- Opening a cut moment, editor notice: `That moment was cut from the video, so the editor is at the
  next part that is kept.`

Colours (dark theme tokens of `styles.css`; contrast on `--surface-1` #141418 / the active row's
`--accent-soft` over it):

| Element | Token | Contrast |
| --- | --- | --- |
| Snippet | `--text-2` #a1a1ad | 7.4:1 |
| Matched words (`mark`) | `--text-1` #f4f4f6, bold, `--accent-soft` background | 15.6:1 (≥ 11:1 on the soft fill) |
| Kind label, time | `--text-3` #8a8a96 | 5.4:1 |
| `Cut` tag | `--warning-text` #fcd34d on `--warning-soft` | 12:1 |
| Active row | `--accent-soft` fill + 2 px `--focus-ring` outline | the outline is 6.8:1 against the surface |

## 6. Security and privacy

- The renderer only sends a query string (≤ 200 characters, typed-checked) and gets plain data
  back. Every `search:*` channel checks that the sender is the main window's own page
  (`getMainWindow().webContents` and `isAppUrl`, the rule of `projectsIpc.ts fromMainWindow`);
  any other window (the notes window, the recording bar, a camera bubble) is refused.
- The index reads `project.json` only, through the same id rule as `projects.ts`
  (`/^[a-zA-Z0-9_-]+$/` folder names in the app's own roots), with a size cap; it follows no path
  from inside a project file. It writes only `userData/search/index.json`.
- Snippets are text parts, rendered as React text nodes (§2.7), never `innerHTML`.
- **Privacy**: the index never leaves the PC. It is not part of "Copy diagnostics" (the report is
  built from named parts, `src/main/diagnostics.ts`, and none reads it), and the search code never
  logs a query, a term or indexed text: its log lines carry counts and times only ("Search index
  ready: 500 recordings in 1.2 s"). A unit test checks the log lines of a build and of queries.
- A deleted recording's words leave the in-memory index on the next reconcile (Home asks for one
  when its list changes), and the file at the next write (≤ 3 s later).

## 7. Undo

Search changes nothing in a project, so there is nothing to undo. Opening at a moment is a seek
(not an edit) and adds no undo step.

## 8. Performance (500 recordings)

Measured by `tests/searchBench.test.ts` on synthetic projects: 500 recordings, each with a name, 5
chapters, 3 titles, 4 text overlays, a 5-minute transcript of 70 captions (770 words) drawn with a
Zipf-like skew from a 6,000-word mixed English and Bangla vocabulary, and 8 lines of notes (6.5 MB
of project.json in all). In this container (Node 22 under vitest, one busy core; a Windows laptop
is typically faster). The test asserts generous limits only, so machine load cannot fail it:

| Step | Measured | Limit in the test |
| --- | --- | --- |
| Parse, extract and index all 500 (the first build, file reads aside) | 0.82–1.0 s in all; the slowest project 13 ms (one slice) | 10 s |
| Write the index file (serialise) | 37–55 ms | – |
| Index file | 5.5 MB (the text it holds, as compact JSON) | 15 MB |
| Load the file and make the terms again | 0.74–0.83 s, one project per slice | 10 s |
| A query: a rare word / a word in every recording / two common words / a typo | 4–9 ms / 15–19 ms / 22–27 ms / 14–16 ms | 200 ms |
| The loaded index's memory | 24 MB | – |

A query's cost is the vocabulary scan for prefixes and typos (~4 ms for the ~10,000 terms here)
plus a pass over the words of every recording that holds all the query's words; moments and
snippets are made only for the 50 recordings returned. Typing is debounced by 150 ms, so even the
slowest query here is answered before the next one is sent.

## 9. Files and exported signatures

New:

- `src/shared/search/types.ts`: `SearchKind`, `SearchUnit`, `IndexedProject`, `SearchMoment`,
  `SearchHit`, `SearchResponse`, `SearchStatus`, `SnippetPart`, `SEARCH_INDEX_VERSION`,
  `SEARCH_LIMITS`.
- `src/shared/search/normalize.ts`: `normalizeText(s)`, `tokenize(s): Token[]` (`{ term, start, end }`), `queryTerms(q)`.
- `src/shared/search/extract.ts`: `projectUnits(project: unknown): SearchUnit[]`, `indexedProject(project, stamp)`.
- `src/shared/search/distance.ts`: `prefixDistance(query, term, max)`, `editDistance(a, b, max)`.
- `src/shared/search/engine.ts`: `class SearchIndex { add(id, entry); remove(id); has(id); ids(); search(query, opts): SearchHit[] }`.
- `src/shared/search/snippet.ts`: `snippetOf(text, ranges): SnippetPart[]`.
- `src/shared/search/indexFile.ts`: `parseIndexFile(raw): Map<string, IndexedProject>`, `serializeIndex(map)`.
- `src/shared/search/moment.ts`: `momentTarget(clips, t): { t: number; cut: boolean }`, `momentLabel(kind)`, `spokenTime(seconds)`.
- `src/shared/api/search.ts`: `SearchApi` (`searchLibrary`, `refreshSearch`, `onSearchStatus`), `SEARCH_CHANNELS`.
- `src/main/search/searchService.ts`: `SearchService` (`start`, `reconcile`, `refresh`, `noteSaved`, `query`, `writeNow`, `dispose`: the queue, debounced saves and writes), with an injectable disk (`SearchDisk`), clock and log.
- `src/main/search/searchIpc.ts`: `registerSearchIpc()`, `noteProjectSaved(project)`, `disposeSearch()`.
- `src/preload/search.ts`: `searchApi`.
- `src/renderer/src/search/LibrarySearch.tsx`, `rows.ts` (the result rows and their screen reader
  text, pure), `search.css`, `openAt.ts`, `useSearchMoment.ts`.
- Tests: `tests/search*.test.ts`, `tests/e2e/search.e2e.cjs`.

Additive lines in shared files: `src/main/index.ts` (register, dispose), `src/main/projectsIpc.ts`
(one line in `saveProjectNow`), `src/preload/index.ts`, `src/shared/api.ts`, `Home.tsx` (import,
the box in the library head, results in place of the grid), `Editor.tsx` (import and one hook call).

No new dependency: `Intl.Segmenter` is in Electron's ICU, and the rest is small code.

## 10. Risks

### Known limits (accepted)

- `strasse` does not find "Straße" (`toLowerCase` keeps ß; full case folding would need a table).
- `京都` does not find "東京都": the word breaker splits it as 東京 + 都, and matching is by word
  prefix. Indexing every Han character on its own (bigrams) would fix it at about twice the index size.
- At most 50 recordings are returned; the count then says "The first 50 recordings found. Add a word
  to narrow them."

### Found in review and fixed

- New results of the same query (while the index is built) used to reset the active row, so Enter
  could open another recording: the active row is now kept by its key (the recording, the kind and the
  time of the moment), and Enter opens nothing when that row is gone.
- An index file entry is held to the caps of §2.2 (text, notes, kept ranges); a hostile entry of
  56 MB took 6 s to index in one go and is now dropped and read again from its project.
- The vocabulary is made again when most of its terms are dead (autosaves replace a recording's
  words), so a long editing session does not slow down every keystroke's scan.
- The stamp of a save is the stat taken right after its write, not 1.5 s later.
- The file is never written before it was loaded, nor when it is too large to read back (64 MB).
- A project folder named `__proto__` is stored like any other.
- Snippets in scripts without spaces keep their text before the match and never cut a surrogate pair.
- The live region stays quiet while the index is built; Ctrl+F does nothing on an empty library.
- Writing the file is synchronous, like every state file (37–55 ms for 500 recordings, at most every
  3 s and only after a change); an asynchronous write is left for later.


- **The first build on a big library** reads every `project.json` (500 × ~100 KB = 50 MB of JSON):
  about 2–4 s of reads on a slow disk, in the background, one file per slice; parsing a large file
  is one synchronous `JSON.parse` (~10 ms for 1 MB) and cannot be sliced. A 64 MB cap keeps a
  pathological file from stalling the app.
- **Windows file locks** (OneDrive, antivirus) on the index file: writes retry like every state
  file and are tried again 3 s later; the in-memory index keeps working.
- **ICU word breaking** differs between ICU versions (Electron updates): queries and text are split
  by the same breaker at the same time (terms are made at load), so they always agree.
- **Recordings changed outside the app** (copied folders, OneDrive sync) are picked up by the stamp
  on the next reconcile.
- **Timing of a cut moment**: the target is computed from the clips at open time, so it is right
  even if the project changed after it was indexed.

## 11. Test plan

Unit (vitest), each failing without its rule:

- `searchNormalize.test.ts`: NFKC, case, Latin accents removed, Bangla vowel signs kept, nukta
  forms equal, ZWJ/ZWNJ removed, apostrophes, CJK/Thai segmentation, term offsets map back to the
  original text, 40-code-point cap.
- `searchDistance.test.ts`: edit distance with swaps, bounded early exit, prefix distance.
- `searchExtract.test.ts`: every kind from a project, caps, garbage in project.json ignored, notes
  paragraphs, imported file name, `{}` and old projects give units without throwing.
- `searchEngine.test.ts`: AND across units, exact > prefix > typo, short-term rules, phrase bonus,
  field weights, ordering of recordings and moments, cut flag, limits, removal, Bangla prefix.
- `searchSnippet.test.ts`: windows, ellipses, line breaks, HTML stays text.
- `searchIndexFile.test.ts`: round trip, version mismatch, bad entries dropped.
- `searchService.test.ts`: reconcile adds, updates (stamp) and drops; save note debounce; writes
  coalesced; corrupt and old-version files rebuilt; a query during the build says building; no
  indexed text or query in any log line.
- `searchMoment.test.ts`: target inside a clip, in a cut, after the last clip; spoken time.
- `searchBench.test.ts`: the numbers of §8 with generous limits.

End to end (`tests/e2e/search.e2e.cjs`, the built app under Xvfb): three seeded recordings (one with
an English transcript and a chapter, one in Bangla, one with only a name) → the box is there,
`Ctrl+F` focuses it; a typo finds the moment; Bangla is found by a prefix; arrow keys and Enter open
the editor with the playhead at the moment; a cut moment shows the notice; an edit saved in the
editor (a new chapter) is found after going back; a deleted recording's results go; the index file
is in userData, holds no project from another folder, and a damaged index file is rebuilt; old
`project.json` files are byte-for-byte unchanged after indexing.

## 12. Left for later (designed, not built)

### 12.1 Text on screen through Windows OCR

- **Engine**: `Windows.Media.Ocr` (`OcrEngine.TryCreateFromUserProfileLanguages`), free, offline,
  in every Windows 10/11 with the language's OCR pack (English is always there; Bangla is **not**
  offered by Windows OCR, so Bangla on-screen text stays unsearchable). Called from the Rust helper
  (`native/`, a new `ocr` subcommand over the `windows` crate, reading PNG frames from stdin), not
  from Node: no new npm dependency, and it runs outside the main process.
- **What is read**: one frame per scene, not per second: frames where the picture changed (the
  still detector's `detectStill` ranges already give the stills; one frame in each still of at
  least 1 s, plus one every 10 s in moving parts), downscaled so the text is 20–40 px high. About
  60 frames for a 10-minute recording, ~80 ms each on a laptop CPU = 5 s per recording, run as a
  background job (hands-off long jobs) only while the PC is idle and on power.
- **Stored** as `ocr` units (`start`–`end` of the still, weight 1.2) in the index only, never in
  project.json; a per-project `ocr.json` cache in the project folder (counted by the storage
  manager as a cache) so a rebuilt index does not read the frames again.
- **Seam**: `OcrPort { recognise(png: Buffer, lang: string): Promise<OcrLine[]> }`, faked in tests.

### 12.2 Search by meaning with a small local model

- **Model**: a multilingual sentence embedder that covers Bangla:
  `paraphrase-multilingual-MiniLM-L12-v2` (Apache-2.0, 118 M parameters, 384 dimensions, ~120 MB
  quantised int8 ONNX) or `multilingual-e5-small` (MIT, 118 M, 384 d). Downloaded on demand like
  the speech models (`docs/design/offline-captions.md`: checksummed, resumable, in userData), never
  bundled.
- **Runtime**: `onnxruntime-node` in a `utilityProcess` (it is ~30 MB of native code: a new
  dependency, justified only by this feature), or the speech sidecar (`native/speech`) extended
  with an `embed` command over `ort` to avoid a Node native module.
- **Units**: captions joined into windows of ~30 s (≈ 75 words), one vector each: 500 recordings ×
  5 min = 5,000 vectors × 384 × 1 byte (int8) ≈ 2 MB; brute-force cosine over 5,000 vectors takes
  < 2 ms, so no vector database is needed.
- **Query**: embed the query (~15 ms on CPU), take the top 20 windows, and blend with the word
  search: `score = word score + 2 × max(0, cosine − 0.35)`; windows only found by meaning are
  labelled `Similar`.
- **Switch**: off by default; Settings › Search › "Also find similar meanings (downloads 120 MB)".

### 12.3 Smaller things

- A Settings section showing the index's size with **Rebuild the index**.
- Search inside the editor (Transcript tab already has its own find).
- Filters (`kind:title`, date ranges) and sorting by date.
