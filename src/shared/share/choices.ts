/**
 * "After export" choices (F-22, docs/design/share.md §2.7): the destinations chosen for each
 * destination preset, kept in the export dialog's localStorage as
 * { v: 1, byPreset: { youtube: ['cf…', 'whk…'] } }. Pure.
 */

export interface ShareChoices {
  v: 1
  byPreset: Record<string, string[]>
}

/** The key for the dialog's preset: its id, or "custom" when none is chosen. */
export const presetKey = (preset: string | undefined | null): string => (preset && /^[A-Za-z0-9_-]{1,40}$/.test(preset) ? preset : 'custom')

const ID_RE = /^(cf[0-9a-f]{10}|whk[a-z0-9]{1,30})$/
const MAX_IDS = 12
const MAX_PRESETS = 50

/** Stored choices, checked: unknown shapes read as none, bad ids are dropped, lists capped. */
export function readShareChoices(raw: unknown): ShareChoices {
  const out: ShareChoices = { v: 1, byPreset: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const by = (raw as { byPreset?: unknown }).byPreset
  if (typeof by !== 'object' || by === null || Array.isArray(by)) return out
  for (const [key, ids] of Object.entries(by).slice(0, MAX_PRESETS)) {
    if (presetKey(key) !== key || !Array.isArray(ids)) continue
    out.byPreset[key] = [...new Set(ids.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))].slice(0, MAX_IDS)
  }
  return out
}

/** The ids chosen for `preset` that are still offered (`valid`), in the order they are offered. */
export function choicesFor(choices: ShareChoices, preset: string | undefined | null, valid: readonly string[]): string[] {
  const chosen = new Set(choices.byPreset[presetKey(preset)] ?? [])
  return valid.filter((id) => chosen.has(id))
}

/** `choices` with `ids` for `preset` (ids no longer offered dropped; an empty list removes the key). */
export function withChoices(choices: ShareChoices, preset: string | undefined | null, ids: readonly string[], valid: readonly string[]): ShareChoices {
  const key = presetKey(preset)
  const keep = valid.filter((id) => ids.includes(id)).slice(0, MAX_IDS)
  const { [key]: _old, ...rest } = choices.byPreset
  const byPreset = keep.length ? { ...rest, [key]: keep } : rest
  const keys = Object.keys(byPreset)
  // The oldest presets go first when there are too many (insertion order).
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PRESETS))) delete byPreset[k]
  return { v: 1, byPreset }
}
