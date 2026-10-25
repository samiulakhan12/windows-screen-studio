# Flown brand assets

Masters copied unchanged from Qbexel's Flown brand kit (`flown-brand/`). Everything the app
shows or ships with is made from these files; edit the kit and copy them again rather than
editing them here.

| File | From the kit | Used for |
| --- | --- | --- |
| `flown-app-icon.svg` | `app-icon/svg/flown-app-icon.svg` | `build/icon.ico` 48–256 px, `build/icon.png` (512 px) |
| `flown-app-icon-small.svg` | `app-icon/svg/flown-app-icon-small.svg` | `build/icon.ico` 16–40 px (flat gradient, wider gap between the blades) |
| `flown-mark.svg` | `logo/svg/flown-mark.svg` | the mark at 48 px and up (Settings › About), the installer sidebar |
| `flown-mark-flat.svg` | `logo/svg/flown-mark-flat.svg` | the mark below 48 px (Home title bar) |
| `flown-wordmark-white.svg` | `logo/svg/flown-wordmark-white.svg` | the wordmark on dark (Home title bar, installer sidebar) |

`npm run icons` (`scripts/icons/render-icons.cjs`; on Linux under `xvfb-run -a`) renders
`build/icon.ico`, `build/icon.png` and `build/installerSidebar.bmp` from these masters and
`build/installer-sidebar.svg`, byte for byte the same on every run. In the app the logo is
`src/renderer/src/components/BrandLogo.tsx`, which uses the SVGs as they are.

## Colour

| Name   | Hex       | Use |
| ------ | --------- | --- |
| Cyan   | `#3FCBFF` | gradient start (bottom of the mark) |
| Azure  | `#4D9BFF` | gradient |
| Indigo | `#6252FC` | gradient; the UI accent (`--accent-500`) |
| Violet | `#8B3AFF` | gradient end (top right of the mark) |
| Ink    | `#0D0F1C` | primary background, dark wordmark |
| Ink 2  | `#161829` | surfaces |
| White  | `#FFFFFF` | wordmark on dark |
| Record | `#FF4757` | recording state only (`--record`) |

The UI's `--accent-gradient` runs Cyan → Azure → Indigo → Violet; it is used only behind
non-text elements (progress bars), since white text on Cyan is not readable.

## Usage rules (from the kit)

- **Clear space:** keep space equal to the height of the wordmark's "o" (about 40% of the
  mark's height) on every side.
- **Minimum size:** the horizontal logo at least 96 px (25 mm) wide. Below 48 px use the
  `*-small` / flat art.
- **Backgrounds:** the gradient mark on Ink or white. On photos or busy colour, the solid white
  or black logo.
- **Don't:** recolour the blades, rotate or skew the mark, add effects, or set the wordmark in
  another typeface.
