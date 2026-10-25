# Fix report: wave 4 UI findings

Branch `fix-w4-ui`, based on `48ed9a7`. Findings from `origin/review-w4:review/w4-findings.json`.
Each one was re-checked against the code first, and each fix has a check in the new
`tests/e2e/ui.e2e.cjs`. **All five checks fail on `48ed9a7` and pass on this branch.** (To show
this, the `src/` changes were stashed, the app rebuilt and the test run again. The failure
messages are quoted below.)

| id | verdict | change |
| --- | --- | --- |
| ui:UI-1 | fixed | `src/main/windows.ts`: the overlay and background now match the redesigned title bar |
| ui:UI-3 | fixed | `styles.css`: a focused slider thumb now shows the solid `--focus-ring` |
| ui:UI-4 | fixed | `editor.css`: a compact icon rail when the rail is short, a visible scrollbar below that; `Inspector.tsx`: the open tab scrolls into view |
| ui:UI-5 | fixed | `editor.css` and `shapes.css`: darker segment gradients; `styles.css`: the primary button's hover and pressed colours are darker |
| ui:UI-9 | fixed | `.notice` scoped in `editor.css` (`.notice-slot .notice`) and `recorder.css` (`.record-panel .notice`) |
| ui:UI-12 | fixed | 7 new screenshots of the merged app (2 old ones removed) and a Screenshots section in README.md |
| consistency pass | done | `settings/settings.css`, `views/Toolbar.css`, `views/CameraBubble.css` now use the design tokens (CSS only) |

## ui:UI-1: title bar vs the native window controls

**Re-check.** The finding is real. `createMainWindow` still had `backgroundColor: '#0b0b10'` and
`titleBarOverlay: { color: '#0b0b10', height: 40 }`. The redesigned `.titlebar` is 44 px tall,
uses `--surface-1` (#141418) and has a 1 px `--border-subtle` hairline. The page itself uses
`--surface-0` (#0e0e11).

**Change.** The overlay is now `{ color: '#141418', symbolColor: '#e5e7eb', height: 43 }`.
43 px leaves the 1 px hairline visible under the native buttons, because `.titlebar` is
border-box. The window background is now `#0e0e11`. Comments in `windows.ts` and next to
`.titlebar` in `styles.css` say that the two must change together.

**Proof.** The test "the native window controls match the title bar" reads the overlay literal
from `windows.ts` and compares it with the rendered `.titlebar`:
- the overlay colour equals the bar's computed background;
- the overlay height equals the bar's height minus its bottom border;
- `BrowserWindow.getBackgroundColor()` equals the page background.

On `48ed9a7` it fails with: `overlay colour #0b0b10 is the title bar's #141418`. The native
overlay itself only draws on Windows, so I could not see it under Xvfb. The check compares the
values instead.

## ui:UI-3: slider keyboard focus nearly invisible

**Re-check.** The finding is real. `input[type='range']:focus-visible { outline: none }` removes
the outline, and the only cue left is a 3 px halo of `--accent-ring`. That halo is translucent,
about 1.55:1 against the panel.

**Change.** The focused thumb's shadow is now
`0 0 0 3px var(--accent-500), 0 0 0 5px var(--focus-ring)`. That adds a solid 2 px #a99bff
ring: 7.7:1 on `--surface-1`, the same ring every other control uses. I also removed the unused
`--fill` declaration.

**Proof.** The test "a keyboard-focused slider shows the solid focus ring" moves focus to a
Style-tab slider with Tab and checks that it matches `:focus-visible`. It then screenshots the
thumb and counts pixels of the `--focus-ring` colour: 114 when focused, 8 when not (anti-aliased
edge pixels). On `48ed9a7` the count is 8 focused and 8 unfocused, so the test fails.

## ui:UI-4: Inspector rail hides its scrollbar, and the 10 tabs don't fit

**Re-check.** The finding is real. I measured it at the 1040×680 minimum with a recording that
has a camera, captions, text, shapes and titles:
- the timeline is 335 px tall;
- the rail's client height is 301 px, but its content needs 480 px;
- the last three tabs were hidden, and there was no scrollbar.

**Change.**
- `.inspector` declares itself a size container (`container: inspector / size`). Its height
  comes from the window and the timeline, never from its content.
- `@container inspector (max-height: 480px)` switches the rail to a compact icon-only layout.
  The labels are hidden, but each button keeps its `title` tooltip and accessible name. Buttons
  shrink to 27 px with 1 px gaps, so the ten tabs need 291 px, which fits in 301 px.
- `scrollbar-width: none` and the `::-webkit-scrollbar { display: none }` rule are gone. If the
  rail is ever shorter still, it scrolls with the app's thin scrollbar.
- `Inspector.tsx` adds a ref on the `<nav>` and a layout effect on `tab` that calls
  `scrollIntoView({ block: 'nearest' })` on the active button. A tab opened by a selection or a
  command is therefore always in view.
- Markup, `title`, `aria-label`, `aria-pressed` and every selector the tests use are unchanged.

**Proof.** The test "every Inspector tab is visible and clickable at the minimum window size":
- At 1360×860, the labels are shown.
- At the window's own `getMinimumSize()` (1040×680), with all timeline lanes present:
  - the rail does not overflow;
  - each of the ten buttons lies fully inside the rail and is the element hit at its centre;
  - clicking each one opens its tab.
- With the rail forced down to 140 px, selecting a layout segment opens Camera, the Camera
  button is scrolled into view, and the scrollbar is not hidden.

On `48ed9a7` it fails with: `the rail fits without scrolling at 1040x680 (179px over)`.

## ui:UI-5: contrast below WCAG AA

**Re-check.** The finding is real, and two more segment kinds also failed. I computed the WCAG
ratios for white 11 px labels on each gradient stop, also under `.seg:hover`'s
`brightness(1.1)`:

| element | before (top / hover) | after (lowest stop / hover) |
| --- | --- | --- |
| text segment | 3.14 / 2.62 | 6.18 / 5.34 |
| zoom segment (top stop was tinted with white) | 3.73 / 3.23 | 5.55 / 4.75 |
| shape segment (`shapes.css`, `#0d9488`) | 3.74 / 3.14 | 5.47 / 4.68 |
| primary button, hover (`--accent-400`) | 4.24 | 6.15 (`--accent-600`) |
| primary button, pressed | 6.15 | 7.74 (`--accent-600` mixed 85% with black) |

The other segments (titles, spotlight, pull-back, layouts, captions) were already 4.5:1 or more.

**Change.**
- `.text-seg`: gradient from `--track-text` mixed 55% with black to 45% with black.
- `.zoom-seg`: the white tint is dropped; the gradient now runs from 85% to 70% mixed with black.
- `.shape-seg`: `#0f766e → #115e59`.
- `.btn.primary:hover`: `var(--accent-600)`.
- `.btn.primary:active`: `color-mix(in srgb, var(--accent-600) 85%, #000000)`.
- No token values changed, because `--accent-400` is still used elsewhere.

**Proof.** The test "segment labels and the primary button reach WCAG AA contrast" seeds every
segment kind on a 1600×1000 window. For every non-caption `.seg-label`, it parses the opaque
stops of the computed gradient and asserts at least 4.5:1, plain and at `brightness(1.1)`: 12
labels, the lowest 4.58:1. It then hovers and presses the Export button and checks each state:
resting 5.15, hover 6.15, pressed 7.74. On `48ed9a7` it fails with:
`"2×" on seg zoom-seg linked-next: 3.73:1, hovered 3.24:1`.

## ui:UI-9: `.notice` in both editor.css and recorder.css

**Re-check.** The finding is real. Both rules were top-level and end up in one stylesheet. On
Home, the editor's `white-space: nowrap; overflow: hidden` clipped long warnings. In the
editor, the recorder's amber box replaced the neutral pill.

**Change.** `.notice-slot .notice` in `editor.css` and `.record-panel .notice` in
`recorder.css`. No TSX changes. Every e2e selector (`.notice`, `.notice:has-text(…)`,
`.record-panel .notice`, `.notice-slot`) still matches.

**Proof.** The test "the editor and Home notices keep their own looks":
- **Home:** it adds a long warning (the real PROCESSING_DEFERRED text) to the recording panel.
  The warning wraps (`white-space: normal`, `overflow: visible`, two or more lines, not clipped)
  and keeps the warning colour.
- **Editor:** it triggers a real transport message (adding a zoom inside a zoom). The message is
  the `--surface-2` pill: `rgb(28, 28, 34)`, not flex, `nowrap`, radius 999px.

On `48ed9a7` it fails with:
`Home notice is not given the editor's nowrap/clipping: {"whiteSpace":"nowrap","overflow":"hidden",…,"clipped":true,"lines":1}`.

## ui:UI-12: unreferenced, pre-merge screenshots

**Re-check.** The finding is real. No document linked the 7 PNGs, and they predate the merge:
they have no Captions tab and no AI settings.

**Change.**
- `ui.e2e.cjs` has an opt-in step: `SSW_UI_SHOTS=<dir>` writes the screenshots from seeded
  projects at 1440×900 under Xvfb:
  - a recording with a camera, captions (seeded transcript), text, shapes, a spotlight, a title
    and camera layouts;
  - three more recordings for the Home library.
- New `docs/screenshots/`, all under 300 KB (128 to 293 KB):
  - `home.png`
  - `editor-style.png`
  - `editor-captions.png`
  - `editor-camera.png`
  - `export.png`
  - `settings-ai.png`: Settings with the add-provider form filled in; the key is a dummy and is
    masked
  - `palette.png`
- `editor-zoom.png` and `editor-shapes.png` are removed. Their content (the zoom and shape
  tracks) shows on the timeline in the new editor shots.
- README.md has a new "Screenshots" section with a two-column table. This is the only README
  edit.

Regenerate with:

```bash
npm run build && SSW_E2E_ONLY=screenshots SSW_UI_SHOTS=docs/screenshots xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/ui.e2e.cjs
```

Not done: the finding also proposes README and FEATURES feature-table text for wave 4. That is
outside my allowed edits (only the Screenshots section of the README), so I left it.

## Consistency pass: Settings, recording bar, camera bubble

All changes are CSS only, in the three files. Selectors, markup and behaviour are unchanged.

- **`settings/settings.css`**
  - Old aliases and raw values replaced with tokens: spacing, `--radius-md` and `-lg`,
    `--surface-0`, `-1` and `-2`, `--border-default`, `--text-1` and `-2`, the `--text-*`
    sizes and weights, `--font-display`, `--font-mono`, `--control-sm` and `-md`, and
    `--success-text` (replacing `#6ee7b7`).
  - Section headings follow `.panel h2`.
  - Provider cards and the form use `--highlight-top`.
  - Inputs look like the editor's `.text-field` (hover `--border-strong`, `--accent-500`
    border on focus). They now get the app's single focus ring instead of a custom
    `--accent` outline.
  - The kind picker's ring uses `--focus-ring`.
  - Kept as they were: the Gemini and Claude badge hues, which have no token.
- **`views/Toolbar.css`**
  - The bar's local `--rb-*` variables now point at tokens: `--surface-overlay`,
    `--border-default`, `--text-1` and `-2`, `--record`, `--warning`, `--accent-500`.
  - Font, sizes and weights use the type tokens.
  - Pill radii use `--radius-pill`.
  - The focus ring is `--focus-ring` instead of the accent outline.
  - Danger, warning and success colours use their tokens.
  - The stop button's hover is derived from `--record`.
  - A side effect: the "zoom here" mark is now white on `--accent-500` (5.15:1); before, it was
    on `#8b5cf6` (4.23:1).
- **`views/CameraBubble.css`**
  - This document is injected into the bubble's own window and does not load `styles.css`. So
    it declares, in a commented `:root` block, copies of the tokens it uses (same values), then
    uses them for the surface, text colours, radii, font and transition.
  - The controls gain a `:focus-visible` ring.
  - The old `font: 600 11px/1 inherit` was an invalid shorthand. It is now a valid one built
    from the tokens.

Not touched: `captions.css`, owned by the captions fixer. Observation, not changed: the
recording bar's Stop button and the app's `.btn.record` put white text on `--record` (#ef4444),
which is 3.76:1. That colour is an app-wide semantic token outside these findings.

## Verification

Run on this branch under Xvfb (1920×1080×24):

- `npm run typecheck`: passes.
- `npx vitest run --testTimeout=60000`: **114 files, 1467 tests passed**.
- `npm run build`: passes.
- `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (all files): see below.

Full e2e run in progress; results follow in the next commit.
