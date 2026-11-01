/**
 * The tiles of the caption style gallery and the look's name line (docs/design/captions-studio.md
 * §2.4, §2.5, §5.7, §5.8), without React: which tiles each filter shows, which one is checked, the
 * name and "(edited)", what Reset and a pick write, and each tile's accessible name.
 *
 * Tile ids: a built-in look's id ('bold-pop'), 'mine:<id>' for a saved look, 'brand' for the brand
 * kit's, and 'legacy:<preset>' for the five Classic looks drawn by today's code.
 */
import { withStudioTile, withLegacyTile, studioEdited } from '../../../../shared/captions/studioEdit'
import { LEGACY_TILES, STUDIO_PRESETS, studioPreset, type SavedLook } from '../../../../shared/captions/studioPresets'
import { isTall } from '../../../../shared/engine/reframeData'
import type { CaptionPreset, CaptionSettings, CaptionStudio } from '../../../../shared/types'

export type GalleryFilter = 'long' | 'short' | 'classic' | 'mine' | 'brand' | 'all'
export type TileGroup = 'long' | 'short' | 'classic' | 'mine' | 'brand'

export interface GalleryTile {
  id: string
  name: string
  group: TileGroup
  description: string
  /** The look drawn on the thumbnail and picked; a Classic tile has none (today's code draws it). */
  look: CaptionStudio | null
  /** A Classic tile's preset. */
  preset?: CaptionPreset
  /** The project's Classic look, shown first in every filter (§2.5). */
  current?: true
}

export const LEGACY_PREFIX = 'legacy:'
export const MINE_PREFIX = 'mine:'
export const BRAND_TILE = 'brand'

export const FILTERS: readonly { id: GalleryFilter; label: string }[] = [
  { id: 'long', label: 'Long videos' },
  { id: 'short', label: 'Short clips' },
  { id: 'classic', label: 'Classic' },
  { id: 'mine', label: 'Mine' },
  { id: 'brand', label: 'Brand' },
  { id: 'all', label: 'All' }
]

const GROUP_WORDS: Record<TileGroup, string> = { long: 'long videos', short: 'short clips', classic: 'classic', mine: 'your styles', brand: 'brand kit' }

/** A square-ish frame (1:1): within 5% of square. */
export const isSquare = (w: number, h: number): boolean => w > 0 && h > 0 && Math.abs(w / h - 1) < 0.05

/** The filter a gallery opens on the first time (§2.4): Short clips for tall and square frames, else Long videos. */
export const frameGroup = (frame: { w: number; h: number }): 'long' | 'short' => (isTall(frame.w, frame.h) || isSquare(frame.w, frame.h) ? 'short' : 'long')

/** The filters shown: Mine only with saved looks, Brand only with the brand kit's caption style. */
export function filtersFor(saved: readonly SavedLook[], brand: CaptionStudio | null): readonly { id: GalleryFilter; label: string }[] {
  return FILTERS.filter((f) => (f.id === 'mine' ? saved.length > 0 : f.id === 'brand' ? !!brand : true))
}

/** A filter that can be shown: `wanted` when it is, else the frame's group. */
export function usableFilter(wanted: string | null, frame: { w: number; h: number }, saved: readonly SavedLook[], brand: CaptionStudio | null): GalleryFilter {
  return filtersFor(saved, brand).some((f) => f.id === wanted) ? (wanted as GalleryFilter) : frameGroup(frame)
}

const builtIn = (group: 'long' | 'short'): GalleryTile[] =>
  STUDIO_PRESETS.filter((p) => p.group === group).map((p) => ({ id: p.id, name: p.name, group: p.group, description: p.description, look: p.look }))
const classic = (): GalleryTile[] => LEGACY_TILES.map((t) => ({ id: `${LEGACY_PREFIX}${t.preset}`, name: t.name, group: 'classic', description: t.description, look: null, preset: t.preset }))
const mine = (saved: readonly SavedLook[]): GalleryTile[] => saved.map((s) => ({ id: `${MINE_PREFIX}${s.id}`, name: s.name, group: 'mine', description: 'Saved by you', look: s.look }))
const brandTiles = (brand: CaptionStudio | null): GalleryTile[] => (brand ? [{ id: BRAND_TILE, name: 'Brand', group: 'brand', description: 'The caption style of your brand kit', look: brand }] : [])

/**
 * The tiles of `filter` (§2.5): *All* holds every look but the Classic ones; the project's own
 * Classic look comes first in every filter, labelled "Your current style".
 */
export function galleryTiles(filter: GalleryFilter, settings: CaptionSettings, saved: readonly SavedLook[], brand: CaptionStudio | null): GalleryTile[] {
  const list =
    filter === 'long'
      ? builtIn('long')
      : filter === 'short'
        ? builtIn('short')
        : filter === 'classic'
          ? classic()
          : filter === 'mine'
            ? mine(saved)
            : filter === 'brand'
              ? brandTiles(brand)
              : [...builtIn('long'), ...builtIn('short'), ...mine(saved), ...brandTiles(brand)]
  if (settings.studio) return list
  const id = `${LEGACY_PREFIX}${settings.preset}`
  const own = classic().find((t) => t.id === id)
  return own ? [{ ...own, current: true }, ...list.filter((t) => t.id !== id)] : list
}

/** The tile the project's look is: checked in the gallery (§2.5). A Studio twin of a Classic look is none: it is "your own version" of it. */
export function checkedTile(settings: CaptionSettings): string | null {
  const s = settings.studio
  if (!s) return `${LEGACY_PREFIX}${settings.preset}`
  if (s.from.startsWith(MINE_PREFIX) || s.from === BRAND_TILE || studioPreset(s.from)) return s.from
  return null
}

const legacyName = (preset: string): string | undefined => LEGACY_TILES.find((t) => t.preset === preset)?.name

/**
 * The name line (§2.4): the look's name, and whether it differs from its tile ("(edited)", with
 * Reset). A Studio twin of a Classic look is always edited ("Clean (edited)").
 */
export function lookName(settings: CaptionSettings, saved: readonly SavedLook[], brandName?: string | null): { name: string; edited: boolean } {
  const s = settings.studio
  if (!s) return { name: legacyName(settings.preset) ?? 'Clean', edited: false }
  const name = s.from.startsWith(MINE_PREFIX)
    ? (saved.find((x) => `${MINE_PREFIX}${x.id}` === s.from)?.name ?? 'Your saved style')
    : s.from === BRAND_TILE
      ? brandName || 'Brand'
      : (studioPreset(s.from)?.name ?? legacyName(s.from) ?? 'Your style')
  return { name, edited: studioEdited(s, saved) }
}

/**
 * What Reset ("Go back to Bold Pop as it comes") picks: the look's tile, or the Classic look a twin
 * was made from; null when there is nothing to go back to (a deleted saved look, the brand kit's
 * look without the kit).
 */
export function resetTile(settings: CaptionSettings, saved: readonly SavedLook[], brand: CaptionStudio | null): string | null {
  const s = settings.studio
  if (!s) return null
  if (s.from.startsWith(MINE_PREFIX)) return saved.some((x) => `${MINE_PREFIX}${x.id}` === s.from) ? s.from : null
  if (s.from === BRAND_TILE) return brand ? BRAND_TILE : null
  if (studioPreset(s.from)) return s.from
  return LEGACY_TILES.some((t) => t.preset === s.from) ? `${LEGACY_PREFIX}${s.from}` : null
}

/** The settings with `tile` picked (§5.8): one undo step, `picked` set. */
export function pickTile(settings: CaptionSettings, tile: string, frame: { w: number; h: number }, saved: readonly SavedLook[], brand: CaptionStudio | null): CaptionSettings {
  if (tile.startsWith(LEGACY_PREFIX)) return withLegacyTile(settings, tile.slice(LEGACY_PREFIX.length) as CaptionPreset)
  return withStudioTile(settings, tile, frame, { saved, ...(brand ? { brand } : {}) })
}

/** "Bold Pop, short clips: big capitals, three words at a time, the spoken word turns green" (§2.5). */
export function tileLabel(tile: GalleryTile): string {
  const d = tile.description
  return `${tile.name}, ${GROUP_WORDS[tile.group]}: ${d.charAt(0).toLowerCase()}${d.slice(1)}`
}

/** The tiles Auto style suggests when the camera leads (§5.5, §11.6). */
const CAMERA_TILES = new Set(['bold-pop', 'highlight-box', 'karaoke-fill'])

/** The Suggested badge's description (§2.5). */
export function suggestedReason(tile: string, frame: { w: number; h: number }): string {
  if (CAMERA_TILES.has(tile)) return 'Suggested when you are on camera'
  return frameGroup(frame) === 'short' ? 'Suggested for tall videos' : 'Suggested for wide videos'
}

/** A look's name for the preview's label ("Previewing Bold Pop · Enter uses it", §2.5). */
export function tileName(tile: string, saved: readonly SavedLook[]): string {
  if (tile.startsWith(LEGACY_PREFIX)) return legacyName(tile.slice(LEGACY_PREFIX.length)) ?? 'Classic'
  if (tile.startsWith(MINE_PREFIX)) return saved.find((x) => `${MINE_PREFIX}${x.id}` === tile)?.name ?? 'Your style'
  if (tile === BRAND_TILE) return 'Brand'
  return studioPreset(tile)?.name ?? tile
}
