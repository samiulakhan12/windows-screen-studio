/**
 * The page's tasks for work spread over several (shared/review/slices.ts): each slice runs in a
 * task of its own (a message to itself, which is not held back as a timer is), so the page draws
 * between them; the first one only once the page has drawn what the panel shows before the work.
 */
import type { Tasks } from '../../../shared/review/slices'

const channel = new MessageChannel()
const queue: (() => void)[] = []
channel.port1.onmessage = () => queue.shift()?.()
const soon = (fn: () => void): void => {
  queue.push(fn)
  channel.port2.postMessage(null)
}

/** Tasks whose first runs after the next frame is drawn (or 100 ms, with no frames: a hidden window). */
export function pageTasks(): Tasks {
  let first = true
  return {
    now: () => performance.now(),
    post: (fn) => {
      if (!first) return soon(fn)
      first = false
      let went = false
      const go = (): void => {
        if (went) return
        went = true
        soon(fn)
      }
      window.requestAnimationFrame(go)
      window.setTimeout(go, 100)
    }
  }
}
