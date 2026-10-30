# Build report: Search every recording (F-18)

Branch `feat-search`, from `ccr-b6df7cf7-yked87` (546e479). Design: `docs/design/search.md`.

## What was built

- **A local index** (`src/shared/search/*`, `src/main/search/*`) of each project's name, imported
  file name, chapters, title cards (title and subtitle), text on screen (annotations), captions (one
  unit per caption, with its times) and speaker notes (one unit per line). It is kept in
  `userData/search/index.json`, built in the main process in the background (4 s after start, in
  slices of about 8 ms), and checked against the project folders by each `project.json`'s
  `mtimeMs:size`. It is updated from the project in hand when the editor saves: one call in
  `saveProjectNow`, debounced 1.5 s per project, stamped by a stat right after the write. A file that
  is missing, unreadable, of another version or over the caps is built again. No server, no AI key.
- **Search on Home** (`src/renderer/src/search/*`): a box under *Recent recordings*, focused by
  `Ctrl+F`. Results replace the grid, grouped by recording: the name (with matched words marked),
  date and length, then up to 4 moments with time, kind (*Said*, *Title*, *Chapter*, *On screen*,
  *Notes*), snippet and a *Cut* tag, plus a "more" row. The arrow keys and Enter open the editor at
  the moment, and Escape clears. It is a combobox and listbox with `aria-activedescendant`, each row
  read as one sentence, with a polite live count.
- **Opening at a moment**: Home sets a pending moment (taken once, within 30 s). The editor's one
  added hook seeks there. A moment that was cut goes to the next kept part, with a notice.
- **Matching**: every word must be found, by prefix while typing. Typos are forgiven: one edit from
  4 letters, two from 8, a swap counting as one, never for numbers. Text is folded with NFKC and
  lowercased. Accents are removed on Latin, Greek and Cyrillic only; Bangla vowel signs are kept and
  nukta forms are treated alike. Joiners and apostrophes are dropped. Chinese, Japanese and Thai are
  split by `Intl.Segmenter`. There is no stemming (design §2.4).
- **Designed only (§12)**: on-screen text through Windows OCR (via the Rust helper), and search by
  meaning with a small multilingual embedding model.

## Decisions and why

- **The main process owns the index.** Home is unmounted while the editor saves, and the sandboxed
  renderer cannot read the projects folder. A worker would need a new electron-vite entry for a cost
  the measurements below do not justify.
- **The file stores text, not terms**: terms are made again on load (0.8 s for 500 recordings, in
  slices). The file stays about the size of its text, and a change in tokenizing needs no rebuild.
- **App.tsx is unchanged**: a module-level pending moment carries the time from Home to the editor.
- **Deleting, importing, recording and duplicating are not hooked**, because those files belong to
  other teams. Home asks for a reconcile whenever its list changes. Any query reconciles first when
  the last reconcile is more than 2 s old, which costs one `readdir` and one `stat` per recording.
- **No new dependency.**

## Numbers for 500 recordings (`tests/searchBench.test.ts`, this container)

500 synthetic 5-minute recordings, 6.5 MB of project.json in total.

| What | Measured |
| --- | --- |
| First build (parse, extract, index) | 0.82–1.0 s in total, at most 13 ms per project |
| Index file size | 5.5 MB |
| Load (parse the file, make the terms again) | 0.74–0.83 s |
| Query: rare word / word in every recording / two common words / with a typo | 4–9 / 15–19 / 22–27 / 14–16 ms |
| Memory of the loaded index | 24 MB |

## Tests

- Unit (vitest), 77 tests in 5 files: `searchNormalize`, `searchEngine` (also covers extract,
  snippet, index file and moment), `searchService` (fake disk and clock; also checks that no log
  line holds query or indexed text, and that the preload's channel names match), `searchRows`,
  `searchBench`. To check each test actually guards something, I broke each rule in the code in turn
  (about 30 changes) and confirmed a test fails. The one exception is skipping a save that a newer
  save already replaced; that only saves work, and the end result is the same either way.
- End to end, `tests/e2e/search.e2e.cjs`, 3 tests on the built app:
  - `Ctrl+F`, typo search, the live count, the marked word, arrow keys and Enter open the editor at
    3 s.
  - A cut moment opens at output 4 s with its notice.
  - A rename saved in the editor is found; Escape clears.
  - A Bangla prefix finds an inflected word; notes are found; the no-match text shows.
  - A deleted recording is gone from the results and from the index file.
  - The index file is in userData; a damaged one is rebuilt.
  - An indexed project's `project.json` is unchanged byte for byte, and the query never appears in
    the logs.
- An independent review covered correctness, security, privacy, accessibility and contrast. All of
  its findings were fixed or written down as known limits; see design §10.

## Verification

- `npm run typecheck`: passes.
- `npm run build`: passes.
- `npx vitest run --testTimeout=60000`: 3,869 of 3,870 passed. The failure was
  `tests/groupMove.test.ts › G-PERF` (a timing limit), during a run while a review was also running
  tests. It failed again when re-run as a file under that load and passed when run alone. It does not
  touch search code.
- `xvfb-run … npm run test:e2e`: see the result below.

## Needs a real Windows PC to confirm

- Indexing speed on a slow or OneDrive-synced projects folder, and file locks on `index.json`.
  Writes retry like every other state file.
- The Bangla input methods (Avro, Windows Bangla keyboards): typing and Enter while an input method
  is composing a word.
- Screen reader wording with Narrator and NVDA (combobox, listbox and groups).
