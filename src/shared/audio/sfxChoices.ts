/**
 * The library's sound effects as the editor offers them (docs/design/editing-polish.md §2.6, §10.1,
 * §10.7): grouped (Whooshes, Pops, Clicks, Chimes), the effects that fit a use first; Captions
 * Studio's synthesised sounds in a group of their own, Original. Pure: what the selects list.
 */
import type { SfxRef } from '../types'
import { choice, type Choice } from '../editor/choice'
import { t } from '../i18n/t'
import { SOUND_EFFECTS, type SfxGroup, type SfxUse } from './soundLibrary'
import { sfxGroupName, sfxName } from './soundNames'

const GROUP_ORDER: readonly SfxGroup[] = ['whoosh', 'pop', 'click', 'chime']

export interface SfxOption {
  value: SfxRef
  readonly label: string
}

export interface SfxOptionGroup {
  readonly label: string
  options: SfxOption[]
}

/** The words are made when read, where the select shows them (the Graphics tab's table is built when its module loads). */
const optionOf = (e: (typeof SOUND_EFFECTS)[number]): SfxOption => ({
  value: `sfx:${e.id}`,
  get label() {
    return sfxName(e.id)
  }
})
const groupOf = (g: SfxGroup, options: SfxOption[]): SfxOptionGroup => ({
  get label() {
    return sfxGroupName(g)
  },
  options
})

/** Every effect in its group, in catalogue order. */
export function sfxGroups(): SfxOptionGroup[] {
  return GROUP_ORDER.map((g) => groupOf(g, SOUND_EFFECTS.filter((e) => e.group === g).map(optionOf))).filter((g) => g.options.length > 0)
}

/** The effects that fit `use` first ("Suggested"), then every other one in its group. */
export function sfxGroupsFor(use: SfxUse): SfxOptionGroup[] {
  const fit = SOUND_EFFECTS.filter((e) => e.uses.includes(use))
  const rest = SOUND_EFFECTS.filter((e) => !e.uses.includes(use))
  const groups = GROUP_ORDER.map((g) => groupOf(g, rest.filter((e) => e.group === g).map(optionOf))).filter((g) => g.options.length > 0)
  const suggested: SfxOptionGroup = {
    get label() {
      return t('sound.sfxGroup.suggested')
    },
    options: fit.map(optionOf)
  }
  return fit.length ? [suggested, ...groups] : groups
}

/** Captions Studio's own sounds, as they always sounded (§10.7). */
export const ORIGINAL_SOUNDS: readonly Choice<'pop' | 'ding'>[] = [choice('pop', 'sound.effect.originalPop'), choice('ding', 'sound.effect.originalDing')]
