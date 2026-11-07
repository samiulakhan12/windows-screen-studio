/**
 * The sound library's IPC (docs/design/editing-polish.md §14 rule 5): every channel checks its
 * sender (fromApp) and its arguments against the catalogue.
 *
 * Contracts step: the exported signature of part P5 (§17.5), called at start-up; the stub
 * registers no handler yet. Part P5 writes the body.
 */
export function registerSoundLibraryIpc(): void {}
