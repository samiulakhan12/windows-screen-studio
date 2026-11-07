/**
 * Requests to smart tools' parts of the editor (docs/design/smart-tools.md §2.8): the palette's Find
 * chapters asks Text › Chapters › Find chapters (part P2's FindChapters) to run, which may be
 * mounting; it takes the request once mounted, as the Captions tab takes requestCaptions'.
 */
let findChapters = false
const listeners = new Set<() => void>()

/** Asks Find chapters to run (the Text tab is being shown). */
export function requestFindChapters(): void {
  findChapters = true
  for (const l of [...listeners]) l()
}

/** Whether Find chapters was asked to run, taken (false when it was not). */
export function takeFindChaptersRequest(): boolean {
  const asked = findChapters
  findChapters = false
  return asked
}

/** Calls `listener` on each request; returns an unsubscribe function. */
export function onFindChaptersRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
