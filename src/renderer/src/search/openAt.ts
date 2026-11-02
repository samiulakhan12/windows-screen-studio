/**
 * The moment a search result asks the editor to open at (docs/design/search.md §2.10). Home sets it
 * just before it opens the recording; the editor takes it once. Kept outside React so App.tsx does
 * not change, and dropped after 30 s so it never applies to a later open.
 */

/** How long a pending moment waits for its editor. */
export const PENDING_MS = 30_000

interface Pending {
  projectId: string
  t: number
  end: number
  at: number
}

let pending: Pending | null = null

/** Asks the next editor of `projectId` to start at the moment from source second `t` to `end`. */
export function setPendingMoment(projectId: string, t: number, end = t, now = Date.now()): void {
  pending = Number.isFinite(t) && t >= 0 ? { projectId, t, end: Number.isFinite(end) && end > t ? end : t, at: now } : null
}

export function clearPendingMoment(): void {
  pending = null
}

/** The moment for `projectId`, once: taking it clears it (any other project's is cleared too). */
export function takePendingMoment(projectId: string, now = Date.now()): { t: number; end: number } | null {
  const p = pending
  pending = null
  if (!p || p.projectId !== projectId || now - p.at > PENDING_MS) return null
  return { t: p.t, end: p.end }
}
