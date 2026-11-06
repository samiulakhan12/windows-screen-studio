/**
 * Automatic versions (E-12, docs/design/versions.md §2.4): the edit as it is, kept just before an
 * action that changes a lot (Polish in one click, Make my captions great, Remove all in the Transcript
 * tab and in Review mode, Make a vertical version, Open this version). The snapshot goes with the
 * message, so the action never waits for the disk; a failure is logged and never stops the action.
 */
import type { AutoReason, VersionMeta } from '../../../shared/editor/versions'
import type { Project } from '../../../shared/types'

/** Listeners told when a version was kept (the Versions dialog lists it at once). */
const listeners = new Set<() => void>()

export function onVersionsChanged(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function versionsChanged(): void {
  for (const l of [...listeners]) l()
}

/** The version being opened while work holding the edit makes it (protecting). */
let opening: string | undefined

/**
 * Runs `fn` (work holding the edit making it at once: store.finish) while version `id` is being
 * opened: an automatic version that work keeps (Review mode's Remove all) never prunes `id`.
 */
export function protecting(id: string, fn: () => void): void {
  const was = opening
  opening = id
  try {
    fn()
  } finally {
    opening = was
  }
}

/**
 * Keeps `project` as an automatic version before `reason`: the version kept, null when that edit is
 * already kept, or `{ failed }` with the reason. `protect`: a version never pruned (the one being
 * opened; by default the one `protecting` names).
 */
export function keepVersionBefore(project: Project, reason: AutoReason, about?: string, protect: string | undefined = opening): Promise<VersionMeta | null | { failed: string }> {
  let sent: Promise<{ saved: VersionMeta | null }>
  try {
    sent = window.api.saveVersion(project.id, project, { reason, ...(about !== undefined ? { about } : {}), ...(protect ? { protect } : {}) })
  } catch (err) {
    sent = Promise.reject(err)
  }
  return sent.then(
    (r) => {
      if (r.saved) versionsChanged()
      return r.saved
    },
    (err: unknown) => {
      console.warn(`Could not keep a version before ${reason}:`, err)
      return { failed: (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') }
    }
  )
}
