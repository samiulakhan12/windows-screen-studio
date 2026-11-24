/**
 * *Follow what is under it* and *Cover this text everywhere* from the editor (docs/design/auto-blur.md
 * §5.9, §14.1). Main reads the text under a cover and walks it (P4's followCover, underCover and
 * coverEverywhere); what lands is applied in one update through `afterGestures`, against the project
 * as it is then, so a drag meanwhile is never overwritten and never overwrites it (finding 16).
 * *Stop* changes nothing. The screen's text never reaches the renderer, except a name the user
 * chose to remember (§5.9 step 3).
 */
import type { EverywhereRequest, FoundCover, UnderCoverResult } from '../../../shared/api/privacy'
import { displayTime } from '../../../shared/editor/clips'
import { newCoverId, withFollowedPath } from '../../../shared/editor/coverEdit'
import { boxAt, coverSlack, parsePath } from '../../../shared/privacy/coverPath'
import { containsOver } from '../../../shared/privacy/covers'
import { MAX_COVERS, mergeCovers, readPrivacyPrefs } from '../../../shared/privacy/coverData'
import { COVER_DARK } from '../../../shared/privacy/kinds'
import type { Cover, NormRect, Project } from '../../../shared/types'
import type { EditorServices } from '../editor/context'

let requests = 0
/** A request id main accepts (1-64 of [a-zA-Z0-9_-]), unique in this window. */
const newRequestId = (what: string): string => `${what}-${Date.now().toString(36)}-${(++requests).toString(36)}`

/** Cover `id` and where the playhead is on it: its box there (the time held inside the cover). */
function coverAtPlayhead(services: EditorServices, coverId: string): { cover: Cover; t: number; box: NormRect } | null {
  const p = services.store.state
  const cover = p.covers?.find((c) => c.id === coverId)
  if (!cover) return null
  const at = displayTime(p.clips, services.player.time)
  const t = Math.min(Math.max(at, cover.start), Math.max(cover.start, cover.end - 0.001))
  const box = boxAt(cover, t)
  return box ? { cover, t, box } : null
}

/** Stops main's work for the project when `signal` aborts (*Stop*). */
function stopWith(signal: AbortSignal, projectId: string): () => void {
  const stop = (): void => void window.api.stopFind(projectId).catch(() => undefined)
  signal.addEventListener('abort', stop)
  return () => signal.removeEventListener('abort', stop)
}

/**
 * *Follow what is under it* (§5.9): main follows the text under cover `coverId` at the playhead;
 * the followed path lands in one update through `afterGestures`, only on the project it was asked
 * for. *Stop* (`signal`) changes nothing.
 */
export async function runFollow(services: EditorServices, coverId: string, signal: AbortSignal): Promise<'done' | 'none' | 'stopped' | 'busy' | 'failed'> {
  const at = coverAtPlayhead(services, coverId)
  if (!at) return 'failed'
  if (signal.aborted) return 'stopped'
  const projectId = services.store.state.id
  const requestId = newRequestId('follow')
  const off = stopWith(signal, projectId)
  try {
    const r = await window.api.followCover({ projectId, requestId, t: at.t, box: at.box, start: at.cover.start, end: at.cover.end, path: at.cover.path })
    if (signal.aborted) return 'stopped'
    if (!r.ok) return r.reason === 'none' || r.reason === 'stopped' || r.reason === 'busy' ? r.reason : 'failed'
    if (r.projectId !== projectId || r.requestId !== requestId) return 'failed'
    const { store } = services
    await new Promise<void>((done) =>
      store.afterGestures(() => {
        // The project as it is now; a cover deleted meanwhile takes nothing.
        if (store.state.id === projectId) store.update((p) => withFollowedPath(p, coverId, r))
        done()
      })
    )
    return 'done'
  } catch {
    return signal.aborted ? 'stopped' : 'failed'
  } finally {
    off()
  }
}

/** The text under each cover read for *Cover this text everywhere*: main keeps it for this request id only. */
const underRequests = new Map<string, string>()

/**
 * Asks main to read the text under cover `coverId` at the playhead (§5.9 step 1). Main keeps the
 * text for the request until the dialog closes; the renderer gets only whether it looks like a name.
 */
export async function readUnderCover(services: EditorServices, coverId: string): Promise<UnderCoverResult> {
  const at = coverAtPlayhead(services, coverId)
  if (!at) return { ok: false, reason: 'failed' }
  const requestId = newRequestId('under')
  underRequests.set(coverId, requestId)
  try {
    return await window.api.underCover({ projectId: services.store.state.id, requestId, t: at.t, box: at.box })
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** Forgets the read of cover `coverId` (the dialog closed). */
export function forgetUnderCover(coverId: string): void {
  underRequests.delete(coverId)
}

/** Listeners told when the names to hide changed (the dialogs that show the list read it again, finding 28). */
const namesListeners = new Set<(where: 'project' | 'settings') => void>()

/** Calls `listener` when *Cover this text everywhere* added a name to this video's list or Settings'; returns the unsubscribe. */
export function onNamesChanged(listener: (where: 'project' | 'settings') => void): () => void {
  namesListeners.add(listener)
  return () => namesListeners.delete(listener)
}

/** `names` with `name` added once (case and spaces as written). */
const withName = (names: readonly string[] | undefined, name: string): string[] => (names?.includes(name) ? [...names] : [...(names ?? []), name])

/**
 * The places found added as covers of kind `text` in one new group (§5.9 step 2), the user's (they
 * asked for them), each a fresh id; a place the cover already holds is not added again.
 */
export function withEverywhereCovers(project: Project, origin: Cover | undefined, found: readonly FoundCover[], random: () => number = Math.random): { project: Project; added: number } {
  const slack = coverSlack(project.capture?.fps ?? 60)
  const taken = new Set((project.covers ?? []).map((c) => c.id))
  const group = newCoverId(random).slice(2)
  const made: Cover[] = []
  for (const f of found) {
    if (!parsePath(f.path)?.length || !(f.end > f.start)) continue
    if (origin && containsOver(origin, f, slack)) continue
    let id = newCoverId(random)
    while (taken.has(id)) id = newCoverId(random)
    taken.add(id)
    const c: Cover = { id, start: Math.max(0, f.start), end: Math.min(project.duration, f.end), path: f.path, color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color.toLowerCase() : COVER_DARK, kind: 'text', group }
    if (f.lost) c.lost = true
    if (f.thin) c.thin = true
    made.push(c)
  }
  if (!made.length) return { project, added: 0 }
  const all = [...(project.covers ?? []), ...made]
  return { project: { ...project, covers: all.length > MAX_COVERS ? mergeCovers(all, MAX_COVERS) : all }, added: made.length }
}

/**
 * *Cover this text everywhere* (§5.9 step 2): main finds the text read under cover `coverId` wherever
 * it shows; each place lands as a cover of kind `text` in one update through `afterGestures`. With
 * `remember` 'project' and a name main judged name-like, the name joins this video's names in the
 * same update; with 'settings', Settings' names (and main's list kept out of logs). Null when it
 * failed or was stopped (what was found before *Stop* still lands).
 */
export async function runEverywhere(services: EditorServices, coverId: string, remember: EverywhereRequest['remember'], signal: AbortSignal): Promise<{ added: number; name: string | null } | null> {
  const projectId = services.store.state.id
  const requestId = underRequests.get(coverId)
  if (!requestId || signal.aborted) return null
  const off = stopWith(signal, projectId)
  try {
    const r = await window.api.coverEverywhere({ projectId, requestId, remember })
    // An answer for another project or request changes nothing (§5.1, test 247).
    if (!r.ok || r.projectId !== projectId || r.requestId !== requestId) return null
    const name = remember !== 'no' && typeof r.addedName === 'string' && r.addedName ? r.addedName : null
    const { store } = services
    let added = 0
    await new Promise<void>((done) =>
      store.afterGestures(() => {
        if (store.state.id === projectId) {
          store.update((p) => {
            const origin = p.covers?.find((c) => c.id === coverId)
            const out = withEverywhereCovers(p, origin, r.found)
            added = out.added
            if (name && remember === 'project') return { ...out.project, privacy: { ...(out.project.privacy ?? {}), names: withName(out.project.privacy?.names, name) } }
            return out.project
          })
        }
        done()
      })
    )
    if (name && remember === 'settings') await addSettingsName(name)
    if (name) for (const l of [...namesListeners]) l(remember === 'project' ? 'project' : 'settings')
    return { added, name }
  } catch {
    return null
  } finally {
    off()
  }
}

/** Adds `name` to Settings' names to hide (the `privacy` preference) and tells main, so logs leave it out. */
async function addSettingsName(name: string): Promise<void> {
  const prefs = readPrivacyPrefs(await window.api.getPref('privacy')) ?? {}
  const names = withName(prefs.names, name)
  await window.api.setPref('privacy', { ...prefs, names })
  await window.api.setPrivateNames(names).catch(() => undefined)
}
