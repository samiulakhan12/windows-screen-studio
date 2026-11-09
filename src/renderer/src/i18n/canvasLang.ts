/**
 * Drawn frames never follow the UI language (docs/design/output-and-languages.md §9.7): in a
 * translated UI every canvas and 2D context gets `lang="en"`. Part P6; English installs nothing.
 */

/** Pins every canvas's language to English. Part P6; the stub does nothing (English needs nothing). */
export function pinCanvasLanguage(): void {}
