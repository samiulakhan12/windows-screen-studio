# Build report: brand kit (E-03), image overlays and brand fonts (NW-12)

Branch `feat-brand-kit`, from `9dadfbb` (`ccr-b6df7cf7-yked87`, Flown 0.5.0). Design:
[`docs/design/brand-kit.md`](docs/design/brand-kit.md).

## What was built

**Image overlays and stickers (NW-12)**
- `Project.overlays` (`ImageOverlay`): timed in source seconds, placed in the output frame (centre
  normalised to the frame, width and height as fractions of its shorter side, so 16:9 ↔ 9:16 never
  stretches it), rotation, opacity, fade in/out. Drawn after the camera bubble and before text,
  captions, title cards and the watermark (`render/overlayLayer.ts`, one line in `compositor.ts`).
- PNG, JPG, WebP, SVG and animated GIF, plus 12 built-in vector stickers (`shared/render/stickers.ts`,
  no text and no external references, so they draw the same on every PC).
- Added from the new **Images** tab (*Add image…*, sticker grid), by double-clicking the new **Images**
  track, by dropping a file on the editor, or by pasting one (`Ctrl+V` outside text fields and
  dialogs). Placed at the playhead, 3 s; the playhead moves just past its fade-in so it shows at once.
- On the preview (`OverlayEditor.tsx`): drag to move, 8 handles to resize along the rotated axes
  (`Shift` keeps the shape), a round handle to rotate (`Shift`: 15° steps), arrow keys nudge (1 px,
  `Shift` 10 px). The panel has sliders for everything, *Reset shape* and *Delete image*; the track
  moves and trims like text. `Delete` removes the selected image.
- GIFs: every frame decoded once with WebCodecs `ImageDecoder` into bitmaps; the frame shown is
  `gifFrameAt(timing, output ms since the overlay's start)`, so preview and export pick the same frame.
- Files are copied into the project (`overlay-<n>.<ext>`); an identical file is stored once (SHA-256).

**Brand fonts (NW-12)**
- `Project.fonts` (`font-<n>.ttf|otf|woff2`), and `font` on `Annotation`, `TitleCard` and
  `CaptionSettings`. A **Font** menu (`panels/FontPicker.tsx`) on the selected text, the selected
  title card and the Captions look, with *Add font…*.
- Loaded with `new FontFace('FlownFont-<id>', bytes)` after a `fetch` from `studio-media://`
  (`render/fontLoader.ts`): the CSP is unchanged. The text layers draw with
  `"FlownFont-<id>", <the old stack>`, and their width, layout and sprite caches are keyed by the
  font and a load generation. The export waits for the fonts in use.
- A missing or unreadable font draws with Segoe UI; the menu says "(missing: drawn with Segoe UI)"
  and the export dialog lists it (missing images too).

**Brand kit (E-03)**
- `userData/brand-kit.json` + `userData/brand-kit/` (`src/main/brandKit.ts`, `brandKitFiles.ts`,
  `brandKitIpc.ts`): logo with position, size, opacity and margin; up to 6 colours; up to 6 fonts with
  a heading and a text font; intro and outro title cards; a style preset (its look copied in);
  *Apply to new recordings*.
- **Settings › Brand kit** (`settings/BrandKitSection.tsx`) edits all of it and saves every change.
- **Style tab › Apply brand kit** (after Watermark) (`panels/BrandKitBar.tsx`): main copies the kit's files into the
  project, the renderer decodes the logo and loads the fonts, then `applyBrandKit` runs in **one**
  `store.update`. Applying again replaces the kit's intro and outro instead of adding more.
- New recordings: `applyStyleDefaults` (already called by `finalize.ts`) now ends with
  `applyBrandKitToNew`, so the recording side is untouched.

## Decisions and why

| Decision | Why |
|---|---|
| Overlays in the output frame, sized by the shorter side | Same model as text and the watermark: zoom never moves a sticker, a new aspect ratio never stretches it. |
| GIF clock = output (edit) time since the overlay's start; always loops; delays ≤ 10 ms play as 100 ms | Continuous across cuts and speed changes; a freeze frame holds it with the picture; matches what Chromium shows. |
| One decoded raster per file for preview and export (SVG rasterised at 2,048 px, stills ≤ 2,048 px, GIF frames ≤ 720 px and ≤ 200 MB in all) | Parity by construction, bounded memory for a long GIF, cheap rotated draws. |
| Drops and pastes send bytes, never a path | A paste has no path; main never trusts a renderer path. |
| Fonts from bytes, family `FlownFont-<id>` | No CSP change; Chromium's font sanitiser checks every face; a user font named "Segoe UI" never replaces the system font elsewhere. |
| Brand kit applied by one pure function | The editor (one undo step) and new recordings use the same rules; unit-tested without Electron. |
| New recordings through `applyStyleDefaults` | Keeps `src/main/recording/*` untouched (owned by the recording-automation work). |
| New files for everything; one-line edits in shared editor files | The multi-select branch edits `selection.ts`, `Timeline.tsx`, `Inspector.tsx`, the panels and `Editor.tsx` at the same time (see "Merge notes"). |

## Security of imported files

- Type by content, matching the extension (PNG, JPEG, WebP, GIF, SVG; TTF `00 01 00 00`/`true`,
  OTF `OTTO`, WOFF2 `wOF2`), checked in main before copying; sizes: images 25 MB, SVG 2 MB, fonts
  15 MB, logo 20 MB; checked before reading.
- Decompression bombs: a GIF's declared screen size is read before decoding; images over 8,192 px a
  side or 40 MP and GIFs over 1,500 frames are refused before the project points at them.
- SVG: served with `Content-Security-Policy: default-src 'none'` and `nosniff`, and only drawn
  through `<img>`; the e2e test pastes an SVG with `<script>` and `onload` and checks neither ran.
- Paths: stored names come from main (`overlay-<n>`, `font-<n>`, `logo-<n>`) and are checked by
  strict regexes in the media protocol, `migrateProject`, the brand kit reader and every IPC handler;
  the dropped file's name is display text only (`basename`, 200 characters). Tests cover `../`,
  Windows separators and look-alike names.
- IPC: the new handlers accept calls from the app's page only (`isAppUrl`).

## Multi-select (E-06) merged in, and images as a kind

At the lead's request `ccr-b6df7cf7-yked87` (with E-06 at `b7d5b68`) was merged into this branch
(`8ca3e2f`). Three conflicts, both sides kept: the Images tab inside the multi-select Inspector, the
Images track with the tracks' new `multi` prop, both release notes. Then, following
`docs/design/multi-select.md`:

- `overlay` is a `GroupKind` on its own `images` track (`multiSelect.ts`); look class `image` with
  Position X/Y, Size (each image keeps its shape), Rotation, Opacity, Fade in and Fade out
  (`groupEdit.ts`, all but the position are its look); group move and Length (`groupMove.ts`);
  copy, paste and duplicate, where an image *file* pastes only into its own recording and a sticker
  anywhere (`groupClipboard.ts`, skip reason `image-other-recording`); the Images track, the
  preview's Ctrl+click (the rotated box's bounds), box selection and the Images list take part.
- A pasted copy of the kit's intro or outro drops its `brand` mark, so applying the kit again keeps it.
- **Ctrl+V**: multi-select's *Paste items* cancels the key's default, so the browser's `paste` event
  (which my image paste listened to) never fired for a real Ctrl+V. Ctrl+V now first reads the system
  clipboard's image in main (`projects:clipboardImage`, app page only): it is added as an image when
  it was not already on the clipboard when items were last copied (SHA-256 fingerprint taken at
  Ctrl+C / Ctrl+X); otherwise the items paste as before.
- Two multi-select unit tests pin the list of kinds and tracks; they now include `overlay` / `images`.

Layout fixes found by the e2e suite after the merge (each was caused by this branch):
- the Images track shows once a project has an image, like the caption and camera tracks (an
  always-present row pushed the Style tab's Padding below the fold of the default window);
- *Apply brand kit* sits after Watermark in the Style tab, not at its top (same reason);
- the compact Inspector rail gives each tab 3 px of padding instead of 5, so eleven tabs fit the
  minimum window (1040 × 680) without scrolling;
- `editor.e2e` clicked `button:has-text("Image")` for the background's *Image…* button, which now
  also matched the Images tab: the selector is scoped to `.insp-body button:has-text("Image…")`;
  `ui.e2e`'s list of tabs includes Images.

## Tests

New unit tests (vitest), each failing without its code (the font-key cache test was checked by
removing the font from the key):

| File | What |
|---|---|
| `tests/imageOverlays.test.ts` | geometry (shorter-side sizing, rotated resize, Shift keeps aspect, limits, rotation and 15° snap), fades in output time, GIF delays and looping, GIF memory and size caps, GIF header size, stickers carry no script/text/external refs, reading stored overlays/fonts/brand, old projects keep no new fields |
| `tests/brandFonts.test.ts` | TTF/OTF/WOFF2 sniffing and mismatches, file-name regex, font stacks and fallbacks |
| `tests/brandLayers.test.ts` | title, caption and text layers draw with the brand font; widths measured with another font are not reused; overlays drawn rotated about their centre at their box with their alpha |
| `tests/overlayAssetsMain.test.ts` | overlay and font assets: names, dedup by content, size limits (25 MB, SVG 2 MB, fonts 15 MB), content checks, dropped names never used as paths, media protocol regex |
| `tests/brandKit.test.ts` | `sanitizeBrandKit`, `applyBrandKit` (all parts, re-apply replaces intro/outro, fonts chosen by hand kept, clashing ids, missing files left out, one undo step), intro/outro times |
| `tests/brandKitMain.test.ts` | the kit on disk: adding checked files, saving removes unused files, copying into a project, new recordings with and without *Apply to new recordings* |
| `tests/overlayMultiSelect.test.ts` | images in a group: track and words, Images section and Mixed, one opacity for all as one undo step, size keeps shape, copy/paste look, move/length/delete, clipboard rules, brand mark dropped on paste |

End to end, `tests/e2e/brand-kit.e2e.cjs` (6 tests): preview vs export pixels for a rotated PNG and
a GIF (four GIF frames, frame-exact), a brand font in captions (same layout in preview and export,
different from the default font, one undo), Apply brand kit (preview vs export of logo and intro, one
`Ctrl+Z` restores the project exactly, redo), drop and paste (SVG with `<script>` and `onload` drawn,
never run; dragging the box moves it as one undo step; Delete), images in a multi-select group (one
opacity, one undo) and real `Ctrl+V` (copied items vs a newer clipboard image), Settings › Brand kit.
The test font is a printable-ASCII subset of DejaVu Sans Mono (`tests/fixtures/fonts`, license beside it).

## Verification (final state of the branch)

| Check | Result |
|---|---|
| `npm run typecheck` | passes |
| `npx vitest run --testTimeout=60000` | **210 files, 2,912 tests passed.** Two earlier full runs failed one test, `groupMove.test.ts › G-PERF` (a 250 ms wall-clock limit; 300 ms here under full parallel load). The base branch fails it the same way in this container (322 ms), and benchmarking `moveGroup` alone shows no difference between this branch and the base (medians 79–83 ms vs 79–84 ms). The test was not changed. |
| `npm run build` | passes |
| e2e group `brand-kit style-pack titles shapes captions export editor` (13 files by name match) | 12/13 files passed; both failures were in `editor.e2e` and caused by this branch (Padding below the fold, the `Image` selector). After the fixes `editor`, `audit-editor` and `brand-kit`: 3/3 files, 22 tests passed. |
| full e2e `npm run test:e2e` (53 files) | **51/53 files, 233 tests passed, 2 failed**: `ui.e2e` (the rail at the minimum window, caused by the Images tab; fixed) and `audio-pack` (a Chromium recording's mic stem 20 ms ahead of the mixed sound, recording code this branch does not touch). Re-run once after the fix: `ui.e2e` and `audio-pack` 2/2 files passed (the stem was aligned exactly). The speech sidecar was built (`npm run build:speech-host`) and the test model fetched for `bangla-captions` and `offline-captions`, which passed. |

Screenshots: `docs/screenshots/brand-kit-{applied,settings,images-panel,overlays-editor,overlays-export,group,font-picker}.png` (all under 130 KB).
