/**
 * The Publish dialog's remembered tone, length and provider (docs/design/publish-pack.md §2.6): a
 * per-user preference, not part of the video, so it lives in localStorage and is read with a
 * sanitiser. Kept for the session when storage is blocked.
 */
import { DEFAULT_PUBLISH_PREFS, readPublishPrefs, type PublishPrefs } from '../../../shared/publish/pack'

/** localStorage key: JSON { tone, length, provider }. */
export const PUBLISH_PREFS_KEY = 'publish-pack'

let unstored: PublishPrefs | null = null

export function loadPublishPrefs(): PublishPrefs {
  if (unstored) return unstored
  try {
    const raw = localStorage.getItem(PUBLISH_PREFS_KEY)
    return raw ? readPublishPrefs(JSON.parse(raw)) : { ...DEFAULT_PUBLISH_PREFS }
  } catch {
    return { ...DEFAULT_PUBLISH_PREFS }
  }
}

export function savePublishPrefs(prefs: PublishPrefs): void {
  const clean = readPublishPrefs(prefs)
  try {
    localStorage.setItem(PUBLISH_PREFS_KEY, JSON.stringify(clean))
    unstored = null
  } catch {
    unstored = clean
  }
}
