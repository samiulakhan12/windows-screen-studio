/**
 * Opening Review filtered to *Private* (docs/design/auto-blur.md §2.1, §2.6, §2.12): the *Review*
 * buttons of the Private info section, Find's result and the export note ask for it, then run the
 * editor's Review command. A panel that opens takes the request; one already open hears it.
 */

let wanted = false
const listeners = new Set<() => void>()

/** Asks the Review panel to show private items only (taken by the panel that opens next, or heard by one open). */
export function requestPrivateReview(): void {
  wanted = true
  for (const l of [...listeners]) l()
}

/** Takes the request (once): whether Review should open filtered to private items. */
export function takePrivateReview(): boolean {
  const w = wanted
  wanted = false
  return w
}

/** An open panel hears requests made while it is open; returns the unsubscribe. */
export function onPrivateReview(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Opens Review on private items: the request, then the editor's Review command. */
export function openPrivateReview(command: (id: 'review') => void): void {
  requestPrivateReview()
  command('review')
}
