/**
 * The sound library's words in the UI language (docs/design/output-and-languages.md §10.5 X2, wave
 * 10's moods): the moods of the music filter, the effects' names and their groups. soundLibrary.ts
 * is in main's import graph (main serves and checks the library's files), which may hold only the
 * common, errors and main messages, so its catalogue keeps today's English titles and the editor
 * names them from here.
 */
import { t, type MessageKey } from '../i18n/t'
import { soundEffect, type Mood, type SfxGroup } from './soundLibrary'

/** "Calm", "Lo-fi": a mood chip. */
export const moodName = (mood: Mood): string => t(`sound.mood.${mood}` as const)

/** "Whooshes", "Pops": a group of effects in a select. */
export const sfxGroupName = (group: SfxGroup): string => t(`sound.sfxGroup.${group}` as const)

/** Each library effect's name, by its id (the catalogue's `title` in English). */
const EFFECT_NAMES: Readonly<Record<string, MessageKey>> = {
  'whoosh-in': 'sound.effect.whooshIn',
  'whoosh-out': 'sound.effect.whooshOut',
  'whoosh-soft': 'sound.effect.whooshSoft',
  'swish-quick': 'sound.effect.swishQuick',
  pop: 'sound.effect.pop',
  'pop-soft': 'sound.effect.popSoft',
  'pop-bubble': 'sound.effect.popBubble',
  click: 'sound.effect.click',
  tick: 'sound.effect.tick',
  bell: 'sound.effect.bell',
  chime: 'sound.effect.chime',
  success: 'sound.effect.success',
  rise: 'sound.effect.rise',
  fall: 'sound.effect.fall',
  'bubble-in': 'sound.effect.bubbleIn',
  drop: 'sound.effect.drop'
}

/** "Soft whoosh": a library effect by its id; an effect this list lacks keeps its catalogue title. */
export function sfxName(id: string): string {
  const key = Object.prototype.hasOwnProperty.call(EFFECT_NAMES, id) ? EFFECT_NAMES[id] : undefined
  return key ? t(key) : (soundEffect(id)?.title ?? t('sound.effect.unknown'))
}
