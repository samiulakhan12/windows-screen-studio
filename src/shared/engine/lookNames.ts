/**
 * The names the editor shows for the engine's built-in looks, in the UI language
 * (docs/design/output-and-languages.md §9.1, part X1): gradients, animated gradients, wallpapers,
 * zoom easings and tilt presets. Their tables (backgrounds.ts, wallpapers.ts, easing.ts, tilt.ts)
 * keep the English names as data, because main imports those modules for their ids and drawing and
 * carries only the common, errors and main messages (test 86); this module, which main never
 * imports, gives each name its message, `editor.look.<table>.<id>`. In English every name is the
 * table's own (tests/i18nLookNames.test.ts).
 */
import { t, type MessageKey } from '../i18n/t'
import type { ZoomEasing } from '../types'
import { ZOOM_EASINGS } from './easing'
import { TILT_PRESETS } from './tilt'

/** A message key made from a table's id; the test holds every id of every table to a message. */
const key = (k: string): MessageKey => k as MessageKey

/** A gradient background's name ("Aurora"). */
export const gradientName = (id: string): string => t(key(`editor.look.gradient.${id}`))

/** An animated gradient's name ("Aurora flow"). */
export const animatedName = (id: string): string => t(key(`editor.look.animated.${id}`))

/** A wallpaper's name ("Violet mesh"). */
export const wallpaperName = (id: string): string => t(key(`editor.look.wallpaper.${id}`))

/** A zoom easing's name and tooltip ("Smooth", "Eases in and out evenly"). */
export const easingLabel = (value: ZoomEasing): string => t(`editor.look.easing.${value}.label`)
export const easingTitle = (value: ZoomEasing): string => t(`editor.look.easing.${value}.title`)

/** ZOOM_EASINGS as a panel's chips show them: the same values, with their names in the UI language. */
export const zoomEasingOptions = (): { value: ZoomEasing; label: string; title: string }[] =>
  ZOOM_EASINGS.map((e) => ({ value: e.value, label: easingLabel(e.value), title: easingTitle(e.value) }))

/** A tilt preset's name and tooltip ("Hero", "A dramatic product shot from the side and above"). */
export const tiltLabel = (id: string): string => t(key(`editor.look.tilt.${id}.label`))
export const tiltTitle = (id: string): string => t(key(`editor.look.tilt.${id}.title`))

/** TILT_PRESETS as a panel shows them: the same presets, with their names in the UI language. */
export const tiltPresetsShown = (): { id: string; label: string; title: string; angles: (typeof TILT_PRESETS)[number]['angles'] }[] =>
  TILT_PRESETS.map((p) => ({ ...p, label: tiltLabel(p.id), title: tiltTitle(p.id) }))
