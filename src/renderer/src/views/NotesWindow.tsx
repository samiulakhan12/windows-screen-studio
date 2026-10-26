/**
 * The speaker notes window's page (`#/notes`, its own window: see src/main/notes/notesWindow.ts
 * and docs/design/teleprompter.md, "Notes window"). It loads styles.css like every route, so it
 * uses the design tokens directly; its own rules go in NotesWindow.css, scoped to .notes-window.
 *
 * STUB (contracts commit): the export name is frozen (main.tsx renders it); workstream B builds
 * the page. Nothing opens this route until workstream A does.
 */
export function NotesWindow(): JSX.Element {
  return <main className="notes-window" aria-label="Speaker notes" />
}
