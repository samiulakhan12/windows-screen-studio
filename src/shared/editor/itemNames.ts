/**
 * The names the editor shows for shapes, stickers, title card styles and backgrounds, and the zoom
 * level presets (docs/design/output-and-languages.md §9.1). Their tables (shapes.ts, stickers.ts,
 * titles.ts, zoomEdit.ts) are also loaded by main, which carries no renderer message (test 86), so
 * their words are messages here, by the tables' ids, and the tables keep their English for what is
 * not shown.
 */
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'
import type { ShapeKind, TitleCard, TitleCardStyle } from '../types'
import { choice, type Choice } from './choice'
import { SHAPE_KINDS } from './shapes'
import { stickerOf } from '../render/stickers'
import { TITLE_BACKGROUNDS, TITLE_STYLES } from './titles'
import { ZOOM_LEVEL_PRESETS } from './zoomEdit'

const SHAPE_KEYS: Readonly<Record<ShapeKind, { label: MessageKey; title: MessageKey }>> = {
  arrow: { label: 'text.shape.arrow', title: 'text.shape.arrow.title' },
  line: { label: 'text.shape.line', title: 'text.shape.line.title' },
  rect: { label: 'text.shape.rect', title: 'text.shape.rect.title' },
  ellipse: { label: 'text.shape.ellipse', title: 'text.shape.ellipse.title' },
  highlight: { label: 'text.shape.highlight', title: 'text.shape.highlight.title' },
  blur: { label: 'text.shape.blur', title: 'text.shape.blur.title' },
  pixelate: { label: 'text.shape.pixelate', title: 'text.shape.pixelate.title' }
}

/** A shape kind's name ("Box", "Marker"), as shapeLabel gives it in English. */
export const shapeName = (kind: ShapeKind): string => (SHAPE_KEYS[kind] ? t(SHAPE_KEYS[kind].label) : t('text.shape.shape'))

/** The shape kinds with their names and tooltips, in SHAPE_KINDS' order. */
export const shapeKinds = (): { kind: ShapeKind; label: string; title: string }[] => SHAPE_KINDS.map((k) => ({ kind: k.kind, label: t(SHAPE_KEYS[k.kind].label), title: t(SHAPE_KEYS[k.kind].title) }))

const TITLE_STYLE_KEYS: Readonly<Record<TitleCardStyle, { label: MessageKey; title: MessageKey }>> = {
  centered: { label: 'text.titleStyle.centered', title: 'text.titleStyle.centered.title' },
  big: { label: 'text.titleStyle.big', title: 'text.titleStyle.big.title' },
  'lower-third': { label: 'text.titleStyle.lowerThird', title: 'text.titleStyle.lowerThird.title' },
  quote: { label: 'text.titleStyle.quote', title: 'text.titleStyle.quote.title' }
}

const TITLE_BACKGROUND_KEYS: Readonly<Record<TitleCard['background'], { label: MessageKey; title: MessageKey }>> = {
  blur: { label: 'text.titleBackground.blur', title: 'text.titleBackground.blur.title' },
  solid: { label: 'common.label.colour', title: 'text.titleBackground.solid.title' },
  style: { label: 'text.titleBackground.style', title: 'text.titleBackground.style.title' }
}

/** A built-in sticker's name ("Heart", "Thumbs up"), or null for a sticker this version does not have. */
export const stickerName = (id: string): string | null => (stickerOf(id) ? t(`text.sticker.${id}` as MessageKey) : null)

/** A title card style's name ("Lower third"). */
export const titleStyleName = (style: TitleCardStyle): string => (TITLE_STYLE_KEYS[style] ? t(TITLE_STYLE_KEYS[style].label) : t('common.label.title'))

/** Title card styles and backgrounds as options, their words made when shown. */
export const TITLE_STYLE_CHOICES: readonly Choice<TitleCardStyle>[] = TITLE_STYLES.map((s) => choice(s.value, TITLE_STYLE_KEYS[s.value].label, TITLE_STYLE_KEYS[s.value].title))
export const TITLE_BACKGROUND_CHOICES: readonly Choice<TitleCard['background']>[] = TITLE_BACKGROUNDS.map((b) => choice(b.value, TITLE_BACKGROUND_KEYS[b.value].label, TITLE_BACKGROUND_KEYS[b.value].title))

/** The zoom level presets with their tooltips ("Zoom 1.5×", "Pull back: show more background"); the labels stay "1.5×". */
export function zoomLevelPresets(): { value: number; key: string; label: string; title: string }[] {
  return ZOOM_LEVEL_PRESETS.map((p) => ({ ...p, label: fmt.factor(p.value), title: p.value < 1 ? t('zoom.preset.pullBack') : t('zoom.preset.zoom', { level: fmt.factor(p.value) }) }))
}
