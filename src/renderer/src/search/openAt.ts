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
  at: number
}

let pending: Pending | null = null

/** Asks the next editor of `projectId` to start at source second `t`. */
export function setPendingMoment(projectId: string, t: number, now = Date.now()): void {
  pending = Number.isFinite(t) && t >= 0 ? { projectId, t, at: now } : null
}

export function clearPendingMoment(): void {
  pending = null
}

/** The moment for `projectId`, once: taking it clears it (any other project's is cleared too). */
export function takePendingMoment(projectId: string, now = Date.now()): number | null {
  const p = pending
  pending = null
  if (!p || p.projectId !== projectId || now - p.at > PENDING_MS) return null
  return p.t
}
