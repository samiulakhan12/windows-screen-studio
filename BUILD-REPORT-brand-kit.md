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
- **Style tab › Apply brand kit** (`panels/BrandKitBar.tsx`): main copies the kit's files into the
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

## Merge notes (multi-select)

Shared editor files changed by small additive lines only:
`selection.ts` (+3: the `overlay` kind and its case), `Inspector.tsx` (+6/−1: tab, mapping, render
line), `Timeline.tsx` (+3: label and track), `Editor.tsx` (+3: import, `Delete` case,
`<OverlayDropZone>`), `TextPanel.tsx` (+5/−2: two `<FontPicker>`s, brand colours in two pickers),
`CaptionsPanel.tsx` (+2), `StylePanel.tsx` (+2). `commands.ts` and `shortcuts.ts` are not touched.
If multi-select binds `Ctrl+V` and calls `preventDefault` on the key, the paste event never fires:
paste an image only when its own clipboard holds no items.

## Tests

VERIFICATION_PLACEHOLDER
