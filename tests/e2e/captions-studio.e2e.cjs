// Captions Studio (wave 9): the end-to-end test of docs/design/captions-studio.md §16.3, written
// when the parts have merged. Until then this file only holds the contract below and fails, so an
// unwritten test is never counted as passing.
//
// The data-testid values of §2 (frozen by the contracts commit; the UI parts use exactly these):
//
//   Captions › Look (§2.4, part P3)
//     caption-look              the section (shown with a transcript)
//     captions-show             toggle "Show captions"
//     captions-great            button "Make my captions great" (hint under it from the resolved options)
//     captions-great-options    icon button "Choose what Make my captions great does"
//     caption-gallery-filter    chips: Long videos, Short clips, Classic, Mine, Brand, All
//     caption-gallery           the tiles, role="radiogroup", aria-label "Caption style"
//     caption-gallery-more      "Show all styles" (aria-expanded)
//     caption-tile-play         "Play a preview of …", beside the grid (reduced motion)
//     caption-style-name        "Bold Pop" or "Bold Pop (edited)"
//     caption-style-reset       "Reset" while edited
//     caption-style-save        "Save as my style"
//     caption-text, caption-colours, caption-layout, caption-motion, caption-emphasis, caption-speakers
//                               the collapsible sub-sections (aria-expanded)
//   Text (§2.6)
//     caption-font, caption-weight, caption-size, caption-case, caption-tracking
//   Colours (§2.6, §7.3)
//     caption-theme, caption-color-text, caption-color-spoken, caption-color-emphasis,
//     caption-color-emphasis2, caption-outline, caption-shadow, caption-box, caption-box-alpha,
//     caption-glow, caption-gradient, caption-contrast, caption-contrast-fix
//   Layout (§2.6)
//     caption-chunk, caption-words, caption-lines, caption-line-length, caption-position,
//     caption-position-reset, caption-avoid
//   Motion (§2.6)
//     caption-enter, caption-exit, caption-word, caption-spoken, caption-upcoming, caption-strength,
//     caption-speed, caption-calm
//   Speakers (§2.6)
//     caption-speaker-colors    toggle "A colour for each speaker" (disabled while names are off)
//   Emphasis (§2.7)
//     caption-emphasis-find, caption-emphasis-clear, caption-emphasis-size, caption-emphasis-font,
//     caption-emphasis-mark, caption-emphasis-motion
//   Transcript tab (§2.7)
//     caption-row-position      a caption row's menu item "Position": Auto, Top, Bottom
//   Make my captions great's options (§2.8, part P4; role="dialog")
//     great-options, great-style, great-emphasis, great-emoji, great-keywords, great-counters,
//     great-lists, great-speakers, great-chapters, great-quotes, great-tidy, great-sound, great-provider
//   Clean up (§2.9, part P4)
//     caption-cleanup, cleanup-caps, cleanup-punct, cleanup-digits, cleanup-words, cleanup-bleep,
//     cleanup-bleep-sound, cleanup-ai, cleanup-ai-provider, cleanup-run
//   Languages (§2.10, part P4)
//     caption-languages, track-show, track-retranslate, track-remove, track-add, track-translate
//   Graphics (§2.11, part P3)
//     graphics                  the Inspector tab (after Captions, icon "burst")
//     graphics-generate         "Add pop-ups from captions"
//     graphics-sound            select "Sound on pop-ups"
//   Export dialog (§2.13, part P4)
//     export-subtitles          the Subtitles field
//     export-subtitle-streams   "Also inside the video (players can switch them)"
//
// localStorage keys (per window): captions-gallery-filter, captions-look-open, captions-calm-hint.

console.error('captions-studio.e2e.cjs: not written yet (docs/design/captions-studio.md §16.3)')
process.exitCode = 1
