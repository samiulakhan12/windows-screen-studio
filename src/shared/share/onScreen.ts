/** The part of IntersectionObserver used here, so this file needs no DOM types (tests run in Node). */
interface Watcher {
  observe(el: object): void
  disconnect(): void
}
type WatcherClass = new (cb: (entries: readonly { isIntersecting: boolean }[]) => void) => Watcher

/**
 * How long something must stay on screen to count as seen: a page that is still loading pushes a
 * section past for a moment, and a quick scroll past it is not a look.
 */
export const SEEN_MS = 500

/**
 * Calls `onSeen` once, when `el` has stayed on screen (inside the scrollers around it) for
 * `SEEN_MS`, not merely mounted: Settings is one long scrolling page. Returns a function that stops
 * watching.
 */
export function whenOnScreen(el: object, onSeen: () => void, Observer: WatcherClass): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const io = new Observer((entries) => {
    clearTimeout(timer)
    timer = undefined
    if (!entries[entries.length - 1]?.isIntersecting) return
    timer = setTimeout(() => {
      io.disconnect()
      onSeen()
    }, SEEN_MS)
  })
  io.observe(el)
  return () => {
    clearTimeout(timer)
    io.disconnect()
  }
}
