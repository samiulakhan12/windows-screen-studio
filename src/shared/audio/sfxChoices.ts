/**
 * The library's sound effects as the editor offers them (docs/design/editing-polish.md §2.6, §10.1,
 * §10.7): grouped (Whooshes, Pops, Clicks, Chimes), the effects that fit a use first; Captions
 * Studio's synthesised sounds in a group of their own, Original. Pure: what the selects list.
 */
import type { SfxRef } from '../types'
import { SOUND_EFFECTS, type SfxGroup, type SfxUse } from './soundLibrary'

export const SFX_GROUP_LABELS: Readonly<Record<SfxGroup, string>> = { whoosh: 'Whooshes', pop: 'Pops', click: 'Clicks', chime: 'Chimes' }
const GROUP_ORDER: readonly SfxGroup[] = ['whoosh', 'pop', 'click', 'chime']

export interface SfxOption {
  value: SfxRef
  label: string
}

export interface SfxOptionGroup {
  label: string
  options: SfxOption[]
}

const optionOf = (e: (typeof SOUND_EFFECTS)[number]): SfxOption => ({ value: `sfx:${e.id}`, label: e.title })

/** Every effect in its group, in catalogue order. */
export function sfxGroups(): SfxOptionGroup[] {
  return GROUP_ORDER.map((g) => ({ label: SFX_GROUP_LABELS[g], options: SOUND_EFFECTS.filter((e) => e.group === g).map(optionOf) })).filter((g) => g.options.length > 0)
}

/** The effects that fit `use` first ("Suggested"), then every other one in its group. */
export function sfxGroupsFor(use: SfxUse): SfxOptionGroup[] {
  const fit = SOUND_EFFECTS.filter((e) => e.uses.includes(use))
  const rest = SOUND_EFFECTS.filter((e) => !e.uses.includes(use))
  const groups = GROUP_ORDER.map((g) => ({ label: SFX_GROUP_LABELS[g], options: rest.filter((e) => e.group === g).map(optionOf) })).filter((g) => g.options.length > 0)
  return fit.length ? [{ label: 'Suggested', options: fit.map(optionOf) }, ...groups] : groups
}

/** Captions Studio's own sounds, as they always sounded (§10.7). */
export const ORIGINAL_SOUNDS: readonly { value: 'pop' | 'ding'; label: string }[] = [
  { value: 'pop', label: 'Original pop' },
  { value: 'ding', label: 'Original ding' }
]
