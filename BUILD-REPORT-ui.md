# Build report: Wave 4 UI polish

Goal: make the whole app look and feel like a polished pro tool, without changing behaviour,
state, IPC or data.

## Design decisions

- **Refined graphite dark theme.** Neutral, slightly cool surfaces (no purple tint in the
  greys) with five clear levels, hairline borders as translucent white so they work on any
  surface, and one confident accent (electric violet `#6d4aff`, white text on it 5.2:1).
- **Semantic colour only where it means something:** success (saved, done), warning (notices,
  unfinished recordings), danger (delete, errors), record red. Each has solid, text and soft
  variants.
- **Timeline colour per track kind** (clip, zoom, text, shapes, titles, camera layout,
  captions, chapters), used for both segments and the tinted icons in the labels column.
- **Typography:** Segoe UI Variable (Text / Display optical sizes) on Windows, falling back to
  system UI fonts; a 10.5–22 px scale; uppercase micro-labels for section headings.
- **Motion:** short, ease-out transitions (110–280 ms) on hover, press and toggles; dialogs fade
  in by opacity only, so their boxes never move under a click. `prefers-reduced-motion` turns
  durations to zero and stops animations.
- **Focus:** one `:focus-visible` ring everywhere (`#a99bff`, 2 px, offset 2 px; 7.7:1 on
  panels), plus an accent glow on text fields, selects and sliders.

## Tokens (on `:root` in `src/renderer/src/styles.css`)

| Group | Tokens |
| --- | --- |
| Surfaces | `--surface-0` (window) … `--surface-4` (pressed), `--surface-sunken`, `--surface-overlay`, `--scrim` |
| Borders | `--border-subtle`, `--border-default`, `--border-strong` |
| Text | `--text-1`, `--text-2` (secondary, 7.2:1), `--text-3` (tertiary, 5.4:1), `--text-on-accent` |
| Accent | `--accent-500` / `-400` (hover) / `-600` (pressed), `--accent-text`, `--accent-soft`, `--accent-softer`, `--accent-ring`, `--accent-gradient` |
| Semantic | `--success`, `--warning`, `--danger-500`, each with `-text` / `-soft`; `--record` |
| Tracks | `--track-clip`, `--track-clip-fast`, `--track-zoom`, `--track-text`, `--track-shape`, `--track-title`, `--track-layout`, `--track-caption`, `--track-chapter`, `--track-trim`, `--playhead` |
| Focus | `--focus-ring`, `--focus-ring-width`, `--focus-ring-offset` |
| Radii | `--radius-xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `pill` |
| Elevation | `--shadow-1` … `--shadow-4`, `--highlight-top` |
| Spacing | `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 20 · `6` 24 · `8` 32 · `10` 40 |
| Type | `--font-sans`, `--font-display`, `--font-mono`, `--text-2xs` … `--text-2xl`, `--weight-*`, `--leading-*`, `--tracking-caps` |
| Motion | `--dur-fast`, `--dur-med`, `--dur-slow`, `--ease-out`, `--ease-in-out`, `--ease-spring` |
| Controls | `--control-sm` 26 · `--control-md` 32 · `--control-lg` 44 |

The old names (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`, `--accent`,
`--accent-2`, `--danger`, `--rec`, `--radius`) are aliases of the new tokens, so every existing
stylesheet, including ones other builders add, picks up the theme.

**Shared classes to reuse in new UI:** `.btn` (+ `.primary`, `.ghost`, `.danger`, `.small`,
`.icon-btn`, `.round`), `.chip` / `.chips`, `.segmented`, `.toggle`, `.slider` (styled range
inputs), `select` (custom chevron), `.field`, `.panel`, `.modal` / `.modal-head` /
`.modal-foot`, `.overlay`, `.hint`, `.notice`, `.empty-state` (+ `.empty-state-icon`),
`.insp-section` (via `Section`), `.swatch`, `.color-field`, `kbd`.

## What changed per screen

**Home** (`views/Home.tsx`, `styles.css`, `recorder/recorder.css`, `presets.css`)
- Two columns: a scrolling main column and a fixed recording panel.
- *What to record*: a heading with a subtitle that changes with the tab, the
  Screens / Windows / Area segmented control and Refresh. Sources are cards that lift on hover,
  with a check badge and accent ring on the selected one, and an empty state.
- *New recording* panel: a summary of what will be recorded; microphone, camera (with
  preview), system audio, keyboard activity and **frame rate** grouped on one card; presets;
  everything else (countdown, desktop icons, auto-pause, hotkeys) under **More options**; a
  prominent Start recording button pinned to the bottom with the stop hotkey hint.
- *Recent recordings*: a grid of cards with a thumbnail (a frame from each recording, grabbed
  in the renderer one at a time and released at once), duration badge, name and a friendly
  date ("Today, 14:32"); Show in Explorer and Delete appear on hover or keyboard focus. An
  empty state explains what will appear.
- *Unfinished recordings*: their own calm section above the library, with a short
  explanation and Recover / Retry, Show in Explorer and Delete.
- The Settings button stays in the title bar.

**Editor chrome** (`editor/editor.css`, `commands.css`, `exportDialog.css`, track and panel css)
- Title bar: back, editable name (focus glow), undo/redo grouped after a divider, save state
  as a pill (green check when saved, red pill on error), a search-field-style Commands button,
  settings, shortcuts, and Export as the primary action.
- Inspector: an icon rail on a darker strip that fits the 10 tabs (incl. Captions); the active
  tab gets an accent tint and an edge marker; full names in tooltips. Sections are separated by
  hairlines with uppercase micro-headings.
- Controls (`controls.tsx` markup unchanged): restyled sliders (track + ringed thumb), switches
  with a spring, pill chips, framed colour wells and swatches with a ring when picked, corner
  picker with an accent state.
- Preview stage: a sunken, dotted canvas area with a soft frame shadow around the video.
- Transport: a white round play button, tabular timecode, and Split / Zoom / Text in a
  segmented tool group.
- Timeline: one segment look (top highlight, shadow, selected ring) with a colour per kind;
  tinted track-label icons (`zoom-label`, `text-label`, `shape-label` classes added); quiet empty
  lanes that brighten on hover; finer ruler ticks; a glowing playhead; trim handles with grips.
- Dialogs: export (cards for destinations, sunken preview, token-based chips and inputs),
  command palette (larger search, tinted active row, footer bar) and shortcuts dialog restyled
  to match.

## Screenshots (`docs/screenshots/`)

`home.png`, `editor-style.png`, `editor-zoom.png`, `editor-shapes.png`, `editor-camera.png`,
`export.png`, `palette.png` (after the change; 1440 × 900, a seeded project with a webcam,
zooms, text and an arrow). Under Xvfb, source thumbnails show a blank screen.

## Selectors

Every `data-testid`, `aria-label`, role and visible label used by the tests is kept. One move:
the frame-rate chips now sit on Home in `.fps-picker` instead of inside the options section, so
six e2e selectors in `polish.e2e.cjs` and `recording-options.e2e.cjs` changed from
`.rec-options .chip` to `.fps-picker .chip`. "Recording options" is now labelled "More options"
(no test used the old text).

## Verification

VERIFICATION_RESULTS

## Known gaps

- Library thumbnails decode `screen.mp4` in the renderer; on very large libraries the first
  visit takes a moment per card (one at a time, cached for the session). Whether Windows ever
  keeps the file locked has not been checked on a real PC (the video is released right after
  its frame is drawn, and Delete waits for a grab in progress).
- Fonts were checked under Linux/Xvfb only; Segoe UI Variable is expected on Windows 11 and
  falls back to Segoe UI on Windows 10.
- The floating recording bar, the camera bubble, and the new Captions and Settings panels are
  styled by other builders; they inherit the tokens through the aliases.
