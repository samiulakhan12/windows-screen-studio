# Brand kit (E-03), image overlays and brand fonts (NW-12)

Status: designed and built on `feat-brand-kit` (from `ccr-b6df7cf7-yked87`, Flown 0.5.0). §12 "As
built" records where the build differs. Roadmap: `docs/ROADMAP.md` E-03 ("Brand kit") and NW-12
("Image, logo and sticker overlays, plus brand fonts").

Code read for this design: `src/main/assetIpc.ts`, `mediaProtocol.ts`, `security.ts`,
`styleDefaults.ts`, `projectsIpc.ts`, `src/renderer/index.html` (CSP), `src/shared/types.ts`,
`src/shared/engine/{project,watermark,picks,titleData,timeline}.ts`, `src/shared/editor/{editStore,
stylePresets,styleDefaults,titles,annotations,shapes}.ts`, `src/shared/render/{overlays,titleCards}.ts`,
`src/shared/captions/{layout,settings}.ts`, `src/renderer/src/render/{compositor,watermarkLayer,
textOverlays,titleCardLayer,captionsLayer}.ts`, `src/renderer/src/editor/{exporter,player,selection,
Inspector,Timeline,TitleTrack,PreviewStage}.ts(x)`, `panels/{TextPanel,WatermarkSection,StylePresets,
CaptionsPanel}.tsx`, `views/Editor.tsx`, `settings/SettingsDialog.tsx`, the e2e fixtures.

The rules earlier waves set still hold:
- Every visual is a function of source time, so preview, scrubbing and export agree.
- Every edit is one undo step.
- Projects and settings made before this feature open, preview and export exactly as before.

Two other branches are being built at the same time:
- **Multi-select** (`feat/multi-select`) owns `selection.ts`, `Timeline.tsx`, the tracks,
  `Inspector.tsx`, the panels, `Editor.tsx`, `commands.ts` and `shortcuts.ts`. This feature
  changes those files only by **small additive lines** (a union member, a case, an import, one
  JSX line each) and puts everything else in new files (§9).
- **Recording automation** owns `src/main/recording/*`, `src/main/recordingIpc.ts`, `Home.tsx`
  and the recording bar. This feature does not touch them. New recordings get the brand kit
  through `applyStyleDefaults` in `src/main/styleDefaults.ts`, which `finalize.ts` already calls
  (§4.6): the recording side's contract is unchanged.

---

## 1. What the user gets

**Image overlays (NW-12).**
- An **Images** tab in the inspector, with *Add image…*, a grid of 12 built-in stickers, and the
  list of images in the video.
- Three more ways to add: drop an image file on the editor, or paste an image (`Ctrl+V`) while the
  focus is not in a text field. Each is placed at the playhead, 3 s long, in the middle of the frame.
- PNG, JPG, WebP, SVG and animated GIF. SVGs are only ever drawn as pictures (no script, no
  external loads). GIFs play frame-exact in the export.
- On the preview the selected image has a box: drag to move, corner handles resize (hold `Shift`
  to keep its shape), a round handle above it rotates (hold `Shift` for 15° steps).
- In the panel: position X/Y, size, rotation, opacity, fade in, fade out, *Reset shape*, *Delete*.
- On the new **Images** timeline track: blocks move and trim like text; double-click empty space
  opens *Add image…* at that time.
- The image is copied into the project folder (`overlay-<n>.<ext>`), so the project renders the
  same on another PC. Pasting the same picture twice stores it once.

**Brand fonts (NW-12).**
- *Add font…* (TTF, OTF or WOFF2) in the font menu of a selected text, a selected title card and the
  Captions look section. The font is copied into the project (`font-<n>.<ext>`).
- Each of those places has a **Font** menu: *Default (Segoe UI)*, the project's fonts, *Add font…*.
- A font file that is missing or cannot be read is drawn with the default font, and the menu says
  so: "Brand Sans (missing: drawn with Segoe UI)". The export dialog lists it the same way.

**Brand kit (E-03).**
- **Settings › Brand kit**, one place to set: logo (with position, size, opacity, distance from the
  edge), up to 6 brand colours, up to 6 fonts with a heading and a body font, an intro and an outro
  title card (text, subtitle, style, length), a style preset, and **Apply to new recordings**.
- **Apply brand kit** in the editor (Style tab, after Watermark) applies it to the open project as **one undo
  step**; `Ctrl+Z` takes all of it back.
- With *Apply to new recordings* on, every new recording starts with the kit applied.

---

## 2. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Where overlays live | `Project.overlays?: ImageOverlay[]`, timed in **source** seconds like annotations; geometry in the **output frame** (centre normalised to the frame, size as a fraction of its shorter side). | Same model as text annotations and the watermark: a sticker stays where it is put when the camera zooms, and a change of aspect ratio never stretches it (both sides scale with the shorter side). |
| 2 | Draw order | Webcam → **image overlays** → keystrokes → text → captions → title cards → watermark. | Text and captions stay readable over a sticker; a full-frame title card covers it; the logo is on top, as today. |
| 3 | GIF timing | A GIF plays on **edit (output) time** from the overlay's start: frame = the one whose span contains `viewingTime(t) − viewingTime(start)` modulo the GIF's length. Always loops. Delays of 10 ms or less (and missing ones) count as 100 ms (what Chromium does). | Edit time is continuous across cuts and does not jump; it is the clock fades already use. A freeze frame holds the GIF with the picture (edit time stops). |
| 4 | GIF decoding | `ImageDecoder` (WebCodecs) decodes every frame once, composited, into bitmaps scaled to at most 720 px on the long side, and smaller when the frames would pass **200 MB** (RGBA). At most **1,500 frames**. | The export draws exactly the decoded frame for its time; nothing depends on an `<img>` element's own clock, which would not be frame-exact. The cap keeps a long GIF from exhausting memory. |
| 5 | Static images | Decoded once per file, kept at most **2,048 px** on the long side; SVG rasterised once at 2,048 px on the long side (1,024 × 1,024 when it has no size). | One raster for preview and export (same cache in the same window): parity by construction, and drawing a rotated SVG every frame would be slow. |
| 6 | Image validation | Main: extension in the allowed list, content sniffed (PNG, JPEG, WebP, GIF, SVG) and must match the extension, ≤ **25 MB** (SVG ≤ **2 MB**). Renderer, before the project points at it: it must decode, and at most **8,192 px** a side and **40 megapixels**. | The same checks as other assets (`ASSET_SPECS`), plus a decode check so a decompression bomb or a broken file never becomes part of the project. |
| 7 | SVG safety | Served by `studio-media://` with `Content-Security-Policy: default-src 'none'` and `nosniff` (as watermarks today) and only ever drawn through an `<img>` / `ImageBitmap`: SVG loaded as an image never runs scripts or loads external files. | The existing, tested mechanism. No SVG parsing in the app. |
| 8 | How drops and pastes reach main | The renderer sends the **bytes** (`importAssetData(id, 'overlay', name, bytes)`), never a path. | A pasted image has no path; one code path for both. Main never trusts a renderer path. Main checks the byte length before anything else. |
| 9 | Duplicate files | Main hashes (SHA-256) an imported overlay or font and reuses an existing project file with the same size and hash. | Pasting the same logo ten times stores it once. |
| 10 | Overlay files are never pruned | Unlike logo picks, overlay and font files are kept. | Several are in use at once and undo can bring back any of them; a project rarely holds more than a few. |
| 11 | Built-in stickers | 12 flat SVG stickers bundled in code (`shared/render/stickers.ts`), referenced as `sticker: '<id>'`, drawn from `data:` URLs. Not emoji glyphs. | Emoji fonts differ between Windows and other PCs; vector stickers draw the same everywhere and need no file in the project. |
| 12 | Fonts in the project | `Project.fonts?: ProjectFont[]` (`{ id, name, file }`). Text uses one by id: `Annotation.font`, `TitleCard.font`, `CaptionSettings.font`. Absent = the built-in font, exactly as before. | Each text keeps its own choice; old projects have none of these fields. |
| 13 | Font loading under the CSP | The renderer `fetch`es the font from `studio-media://` (allowed by `connect-src`) and registers `new FontFace('FlownFont-<id>', bytes)`. The CSP is **not** changed (no `font-src`). Chromium's font sanitiser (OTS) validates every face it loads. | `FontFace` from bytes does no font fetch, so `default-src 'self'` still blocks any font URL. A malformed font fails to load and falls back (decision 15). |
| 14 | Font family names | Every project font is registered under an internal family `FlownFont-<id>`; the canvas font is `"FlownFont-<id>", <the old stack>`. | A user font named "Segoe UI" can never replace the system font for other text, and two fonts with the same internal name cannot clash. The fallback after it is the exact stack used today. |
| 15 | Missing font | Drawn with the default stack (the CSS fallback), never an error. The Font menu shows "(missing: drawn with Segoe UI)", and the export dialog lists missing fonts above *Export*. | "A missing font falls back clearly." The export never fails for a font. |
| 16 | Parity with fonts | Text measurement caches (title cards, captions) are keyed by the font; the export waits for every font in use (`prepareBrandAssets`) before the first frame; the preview repaints when a font finishes loading. | The caches were keyed only by weight and text: without the font in the key a cached width from another font would lay out wrong. |
| 17 | Font validation | `.ttf` / `.otf` / `.woff2`, ≤ **15 MB**, first bytes `00 01 00 00` or `true` (TTF), `OTTO` (OTF), `wOF2` (WOFF2) matching the extension. | Same pattern as images. WOFF (1) and collections (`.ttc`) are left out: rare for brand fonts and not needed. |
| 18 | Brand kit storage | `userData/brand-kit.json` (versioned, sanitised on read) and its files in `userData/brand-kit/` (`logo.<ext>`, `font-<n>.<ext>`). Missing or malformed file = no kit. | Like `style-defaults.json`. One place, edited in Settings. |
| 19 | What the kit holds | Logo (+ position, size, opacity, margin), colours (≤ 6), fonts (≤ 6) with heading and body font, intro and outro (title, subtitle, style, length 1–10 s), a style preset (name and its look, copied), *apply to new recordings*. | The roadmap's list. The preset look is copied in, so deleting a preset of your own later does not break the kit. |
| 20 | What *Apply* does | In one `store.update`: the preset look (`applyPreset`); the logo as the watermark; kit fonts added to `project.fonts`; captions, and title cards and text that use the default font, take the body (text, captions) and heading (titles) fonts; the intro and outro cards replace the kit's earlier ones (`TitleCard.brand`); `project.brand` keeps the colours and fonts for the pickers. | Re-applying never duplicates the intro and outro. A font the user chose on a text is kept. |
| 21 | Files of *Apply* | Main copies the kit's logo and fonts into the project first (new names, deduplicated), then the renderer preloads them, then applies the single update. | The update only points at files that exist and decoded, and is one undo step. Undo leaves the copied files (harmless, decision 10). |
| 22 | New recordings | `applyStyleDefaults` (main) applies the kit after the saved look when *Apply to new recordings* is on, copying files synchronously. | It is already called by `finalize.ts`; the recording side is unchanged. A failure leaves the recording as it was (logged). |
| 23 | Intro and outro times | Intro: from the first kept moment, `length` output seconds; outro: the last `length` output seconds. Each is at most a third of the kept video; shorter than 0.5 s, it is left out. | A 4 s recording still gets readable cards without covering everything. |
| 24 | UI placement | New **Images** tab (inspector), new **Images** track (timeline), *Apply brand kit* in the Style tab (after Watermark), **Brand kit** section in Settings. | Each is a new file plus one line in a shared file (§9). |

---

## 3. Data model

### `src/shared/types.ts` (additive; every field optional)

```ts
/** An image or sticker shown between `start` and `end` (source seconds), over the frame. */
export interface ImageOverlay {
  id: string
  start: number
  end: number
  /** Project file overlay-<n>.<png|jpg|webp|svg|gif>; absent for a built-in sticker. */
  file?: string
  /** Built-in sticker id (shared/render/stickers.ts); absent for a file. */
  sticker?: string
  /** Name shown in the editor (the file name it was imported from). */
  name?: string
  /** Centre, normalised to the output frame (0..1). */
  x: number
  y: number
  /** Width and height as fractions of the output frame's shorter side. */
  w: number
  h: number
  /** Degrees, clockwise, -180..180. */
  rotation: number
  /** 0.05..1 */
  opacity: number
  /** Fade lengths, output seconds, 0..3. */
  fadeIn: number
  fadeOut: number
}

/** A font file copied into the project (font-<n>.<ttf|otf|woff2>). */
export interface ProjectFont { id: string; name: string; file: string }

/** What the brand kit left on the project: picker swatches and the fonts new text starts with. */
export interface ProjectBrand { colors: string[]; headingFont?: string; bodyFont?: string }

Annotation.font?: string      // a ProjectFont id
TitleCard.font?: string
TitleCard.brand?: 'intro' | 'outro'
CaptionSettings.font?: string
Project.overlays?: ImageOverlay[]
Project.fonts?: ProjectFont[]
Project.brand?: ProjectBrand
```

### Migration (`migrateProject`)

`overlays`, `fonts` and `brand` are read by `readOverlays` / `readFonts` / `readBrand`
(`shared/engine/overlayData.ts`) **only when present**; absent stays absent, so an old project
saves back byte-for-byte the same fields. `readOverlay` drops an entry whose times are not finite
or shorter than 0.05 s, whose file does not match `OVERLAY_FILE_RE`, whose sticker is unknown, or
that has neither; it clamps the numbers to §4.1's limits. `readFont` keeps `font-<n>.<ttf|otf|woff2>`
files only. `readTitleCard`, the annotation list and `readCaptionSettings` keep `font` when it is a
string of at most 40 characters and `brand` when it is `'intro'` or `'outro'`. A font id that names
no project font is drawn with the default font (§4.3).

### Brand kit file (`userData/brand-kit.json`)

```ts
interface BrandKit {
  logo?: { file: string; position: Corner | 'center'; size: number; opacity: number; margin: number }
  colors: string[]                      // ≤ 6, '#rrggbb'
  fonts: { id: string; name: string; file: string }[]   // ≤ 6, files in userData/brand-kit/
  headingFont?: string; bodyFont?: string
  intro?: BrandCard; outro?: BrandCard  // { title, subtitle?, style, length }
  preset?: { name: string; look: PresetLook }
  autoApply: boolean
}
```
`sanitizeBrandKit` (`shared/editor/brandKit.ts`) applies the same rules as above; the file is
written atomically (`writeFileAtomicSync`).

---

## 4. Behaviour

### 4.1 Overlays (`shared/editor/overlays.ts`, `shared/render/imageOverlays.ts`)

| Value | Rule |
|---|---|
| New overlay | starts at the playhead's displayed time (in a cut: the next kept moment), **3 s** long (shorter near the end, never under 0.3 s); centre (0.5, 0.5); long side **0.35** of the frame's shorter side for files, **0.22** for stickers, the other side from the image's aspect; rotation 0; opacity 1; fades 0.2 s. |
| Limits | size side 0.02..2; rotation −180..180; opacity 0.05..1; fades 0..3 s; at most **200** overlays a project. |
| Box in a w × h frame | `m = min(w, h)`; width `w·m`, height `h·m`, centre `(x·w, y·h)`, rotated about its centre. |
| Alpha at `t` | `opacity × min(1, (e − e0)/fadeIn, (e1 − e)/fadeOut)` with `e = viewingTime(t)`, `e0 = viewingTime(start)`, `e1 = viewingTime(end)`; 0 outside `[start, end)`. |
| Resize | Corner/edge handles move one side; Shift keeps the box's aspect. Never smaller than 0.02. |
| Rotate | The angle from the box centre to the pointer, 0° = handle straight up; Shift snaps to 15°. |
| Timeline | Move and trim as text (`dragAnnotationTimes` rules: min 0.3 s, inside the recording); lanes as other tracks. |

### 4.2 GIF frames (`gifFrameAt`)

Given frame delays `d[i]` (ms, `≤ 10` → 100), total `T = Σd`, local time `u = (e − e0) mod T`
(ms), the frame is the last `i` with `Σ_{j<i} d[j] ≤ u`. Pure and unit-tested; preview and export
call it with the same `t`.

### 4.3 Fonts

`fontStack(project, id, fallback)` returns `'"FlownFont-<id>", ' + fallback` when `id` names a
project font, else `fallback` (the exact constant used today: `ANNOTATION_FONT`, `TITLE_FONT`,
`CAPTION_FONT`). Loading: `ensureProjectFonts(project)` fetches each used font once per project
and file, registers it in `document.fonts`, and notifies the preview to repaint. A font that fails
(missing file, OTS rejects it) is recorded as *failed*; `fontStatus(project, id)` → `'ready' |
'loading' | 'missing'` drives the menu's text.

### 4.4 Brand kit apply (`applyBrandKit(project, kit, files, now)`)

Pure. `files` maps kit file names to the project file names main copied (absent = the copy
failed: that part is left out). Steps in order (§2 decision 20). Returns the project unchanged when
the kit is empty. One `store.update` in the editor.

### 4.5 Editor

- *Apply brand kit* (Style tab, after Watermark: the tab's first screen keeps its look controls). Disabled with the hint "Set up your brand kit in Settings
  first" when the kit is empty; while copying "Applying…"; after: notice "Brand kit applied ·
  Ctrl+Z to undo". *Edit brand kit…* opens Settings at the Brand kit section.
- Drop: a file dragged over the editor shows the outline "Drop an image to add it at the
  playhead"; other file kinds give "Only PNG, JPG, WebP, SVG and GIF images can be added".
- Paste: only when the focus is not in an `input`, `textarea` or `contenteditable`, and the
  clipboard holds an image file.

### 4.6 New recordings

`applyStyleDefaults(project, defaults)` in `src/main/styleDefaults.ts` ends with
`applyBrandKitToNew(out)`: when the kit's `autoApply` is on, copies its logo and fonts into the
new project folder (sync) and returns `applyBrandKit(out, kit, files)`; any error is logged and
the project is returned as it was.

---

## 5. UI and copy

| Where | Copy |
|---|---|
| Images tab, empty | **Images and stickers** · *Add image…* · "Or drop an image on the editor, or paste one with Ctrl+V. PNG, JPG, WebP, SVG or GIF, up to 25 MB." |
| Sticker grid | buttons labelled "Add <name> sticker" (Star, Heart, Check, Cross, Thumbs up, Smile, Wow, Fire, Light bulb, Warning, Sparkles, New badge) |
| Selected image | **Selected image** · name · times · Position X, Position Y, Size, Rotation, Opacity, Fade in, Fade out · *Reset shape* · *Delete image* · "Tip: drag on the preview to move; handles resize (Shift keeps the shape) and rotate." |
| Errors | "This image is too large (31 MB; 25 MB at most)." · "This file is named .png but holds a GIF image: rename it to .gif and add it again." · "This image could not be read." · "This image is too large to show (12000 × 9000 pixels; 8192 a side and 40 megapixels at most)." · "This video already has 200 images." |
| Font menu | label **Font** · "Default (Segoe UI)" · fonts by name · "Add font…" · a missing one: "Brand Sans (missing: drawn with Segoe UI)" |
| Settings › Brand kit | **Brand kit** · "Your logo, colours, fonts, intro and outro, saved once." · Logo: *Choose logo…* / *Remove* · Colours: swatches + colour input + *Add colour* · Fonts: *Add font…*, rename, *Remove*, "Headings" / "Text" menus · Intro / Outro: toggle, Title, Subtitle, Style, Length · Style preset menu · toggle **Apply to new recordings** · "New recordings start with your brand kit." |
| Export dialog | "Font missing: Brand Sans. Text that uses it is drawn with Segoe UI." |

Accessibility: every control is a real button/input with a label; the overlay handles have
`title`s and the panel's sliders do everything the handles do, from the keyboard. Colours use the
tokens of `styles.css`; the drop outline uses `--accent` (≥ 3:1 against the stage) and its text
`--text-1` on `--surface-2` (≥ 4.5:1).

---

## 6. Security of imported files

| Threat | Guard |
|---|---|
| Script in an SVG | Only drawn as an image (no `<object>`, no `innerHTML`); served with `default-src 'none'` and `nosniff`. |
| Wrong type behind an extension | Content sniffing must match the extension (images and fonts). |
| Oversized files | Byte limits checked in main before reading (25 MB images, 2 MB SVG, 15 MB fonts) and again for the data path before the bytes are copied. |
| Decompression bombs | Renderer refuses images over 8,192 px a side or 40 MP and GIFs over 1,500 frames before the project points at them; GIF memory bounded at 200 MB. |
| Path traversal | Project file names come from main (`overlay-<n>.<ext>`, `font-<n>.<ext>`) and are checked against strict regexes by the media protocol, `migrateProject` and the IPC handlers; the renderer's `name` is only display text (cut to 80 characters). Brand kit file names likewise (`logo.<ext>`, `font-<n>.<ext>`), read only from `userData/brand-kit/`. |
| Malformed fonts | Chromium's OTS sanitiser rejects them; they fall back. |
| CSP | Unchanged. Fonts load from bytes (`FontFace`), images through `studio-media:` and `data:` (already allowed). |
| IPC from other pages | The brand kit handlers check `isAppUrl(senderFrame.url)`. |

---

## 7. Undo

Every change is one `store.update`; drags use the gesture keys (`overlay-geom:<id>`,
`overlay-drag:<id>`), sliders the slider keys. *Apply brand kit* is one update. Adding a font is
one update (`fonts` and the text's `font` together).

---

## 8. Performance

- Only overlays visible at `t` are drawn (a linear scan; 200 at most).
- Each file is decoded once per window; a rotated `drawImage` per visible overlay per frame.
- A 1,000-frame GIF decodes in the background; the preview shows nothing for it until it is
  decoded, the export waits for it.

---

## 9. Files

New: `src/shared/editor/overlays.ts`, `src/shared/editor/brandKit.ts`, `src/shared/engine/overlayData.ts`,
`src/shared/render/imageOverlays.ts`, `src/shared/render/stickers.ts`, `src/shared/render/fonts.ts`,
`src/shared/api/brandKit.ts`, `src/preload/brandKit.ts`, `src/main/brandKit.ts`, `src/main/brandKitIpc.ts`,
`src/renderer/src/render/overlayLayer.ts`, `src/renderer/src/render/fontLoader.ts`,
`src/renderer/src/editor/{OverlayTrack,OverlayEditor,overlayImport}.tsx/ts`, `overlays.css`,
`panels/{ImagesPanel,FontPicker,BrandKitBar}.tsx`, `src/renderer/src/settings/BrandKitSection.tsx`.

Additive lines in shared files: `types.ts`, `project.ts` (migration), `selection.ts` (one union
member, one case), `Inspector.tsx` (tab, mapping, render line), `Timeline.tsx` (label and track),
`Editor.tsx` (delete case, import hook, tab prop), `PreviewStage.tsx` (one editor line),
`TextPanel.tsx` and `CaptionsPanel.tsx` (one `<FontPicker>` each), `StylePanel.tsx` (one
`<BrandKitBar>`), `compositor.ts` (one draw call), `textOverlays.ts`, `titleCardLayer.ts`,
`captionsLayer.ts` (font stack and cache keys), `exporter.ts` (one prepare call), `assetIpc.ts`,
`mediaProtocol.ts`, `styleDefaults.ts` (main), `SettingsDialog.tsx`, `preload/index.ts`, `api.ts`.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| `ImageDecoder` missing or failing for a GIF | Then the GIF is refused at import with "This GIF could not be read" — never half-working. |
| A GIF's frames differ between decoders | Preview and export use the same decoded frames in the same window. |
| Font metrics differ while a font loads | The export waits for fonts; the preview repaints when they load. |
| Big brand kit fonts slow down new recordings | Copies are local and ≤ 6 × 15 MB; done once at finalize. |
| Merge with multi-select | Additive lines only; a new selection kind `overlay` that multi-select can include later. |

---

## 11. Test plan

Unit (vitest; each fails without its code): overlay geometry, alpha and fades, GIF frame lookup
(delays, clamping, looping), resize/rotate maths (Shift keeps aspect, 15° snap), `readOverlay` /
`readFont` / `readBrand` (old projects unchanged, bad files dropped), content sniffing for every
type and every mismatch, size limits, `importAssetData` (limits, dedup by hash, names), media
protocol regex (overlay and font files, no traversal), `fontStack` (fallback for unknown ids),
title/caption measure cache keys include the font, `sanitizeBrandKit`, `applyBrandKit` (one result,
intro/outro replaced not duplicated, user fonts kept, times inside the kept video), main
`brandKit` store (atomic save, logo/font copy, `applyBrandKitToNew` with and without autoApply).

End to end (`tests/e2e/brand-kit.e2e.cjs`): preview pixels vs export pixels for a PNG overlay; a GIF
overlay's colour at three times (frame-exact in the export and the same in the preview); a brand
font in captions (the export's text pixels differ from the default font and match the preview);
Apply brand kit as one undo step (logo, preset, intro/outro, fonts; one `Ctrl+Z` restores the
project); drop and paste add an image; an SVG with a script is drawn without running it.

---

## 12. As built

Deviations from the text above, and what changed when "select several items" (E-06) was merged in:

- **GIF delays**: 10 ms or less (and missing) play as 100 ms, as in Chromium (the first draft said
  under 20 ms).
- **After adding**, the playhead moves just past the new image's fade-in (`showOverlay`), as title
  cards do: at the playhead itself the image is still invisible.
- **A GIF's declared screen size** is read from its header before `ImageDecoder` runs, so a GIF
  declaring a huge canvas is refused before any frame is allocated.
- **The Images track** shows once the project has an image, like the caption and camera tracks: an
  always-present row cost every project 34 px of preview and pushed the Style tab's Padding below the
  fold of an 860 px window (editor.e2e). The first image comes from the Images tab, a drop or a paste.
- **Apply brand kit** sits after Watermark in the Style tab, not at its top, for the same reason.
- **The export dialog** also lists images that cannot be shown (missing file), not only fonts.
- **Multi-select (E-06)**: `overlay` is a `GroupKind` on its own `images` track
  (`shared/editor/multiSelect.ts`); look class `image` with the fields Position X/Y, Size (each
  image keeps its shape), Rotation, Opacity, Fade in, Fade out (`groupEdit.ts`; all but the position
  are its look); it moves and takes one length with the group (`groupMove.ts`); copy, paste and
  duplicate keep it, but an image *file* pastes only into its own recording (`image-other-recording`)
  while a sticker pastes anywhere (`groupClipboard.ts`); a pasted copy of the kit's intro or outro
  drops its `brand` mark, so applying the kit again keeps the copy. The Images track, the preview's
  Ctrl+click (the rotated box's bounds) and the Images list take part like the other kinds.
- **Ctrl+V** is multi-select's *Paste items*, whose keydown cancels the browser's `paste` event. So
  Ctrl+V first asks main for the system clipboard's image (`projects:clipboardImage`, the app's page
  only, `clipboard.read()` image/png; bytes sent up to 25 MB): when there is one and it was not
  already there when items were last copied (a SHA-256 fingerprint taken at Ctrl+C / Ctrl+X), it is
  added as an image, or refused as too large; otherwise the copied items are pasted as before. The
  `paste` event listener stays for pastes that do not come from that key. An image copied again
  after items, byte for byte the same as before, counts as older (the items paste).
