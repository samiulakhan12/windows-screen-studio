/**
 * Saving, renaming, updating, deleting and importing the user's export presets
 * (docs/design/output-and-languages.md §2.2). Pure: the dialog stores the result in the
 * `exportPresets` preference, which main reads back through readUserPresets.
 *
 * Every function returns a new store and never changes the one it is given. Names go through
 * cleanPresetName and stay unique (compared in NFC, so য় typed either way is one name); options go
 * through normalizeOptions without the ids of the presets they came from; the "Also save" choices go
 * through normalizeBundle without the subtitle languages, which belong to one project (§2.2).
 */
import type { ExportCodec } from '../types'
import { normalizeBundle, type BundleOptions } from './exportBundle'
import { FORMAT_LABELS, normalizeOptions, type ExportOptions } from './exportPresets'
import { codecOf, DEFAULT_CODEC } from './proFormats'
import { cleanPresetName, newPresetId, PRESET_NAME_LIMIT, USER_PRESET_LIMIT, type UserExportPreset, type UserPresetStore } from './userPresets'

/** Options as a user preset keeps them: read like stored settings, without `preset` and `userPreset`. */
function keptOptions(options: ExportOptions): ExportOptions {
  const o = normalizeOptions(options)
  delete o.preset
  delete o.userPreset
  return o
}

/** "Also save" choices as a user preset keeps them: never the subtitle languages. */
function keptBundle(bundle: Omit<BundleOptions, 'languages'> | undefined): Omit<BundleOptions, 'languages'> | undefined {
  if (!bundle) return undefined
  const b = normalizeBundle(bundle)
  delete b.languages
  return b
}

let graphemes: Intl.Segmenter | null = null
const graphemesOf = (s: string): string[] => {
  graphemes ??= new Intl.Segmenter('en', { granularity: 'grapheme' })
  return Array.from(graphemes.segment(s), (x) => x.segment)
}

/**
 * `name`, or `name (2)`, `name (3)` … when `taken` already holds it, compared in NFC. A suffix that
 * would take the name past 60 graphemes shortens the name before it, so the result still reads back
 * through cleanPresetName unchanged.
 */
export function uniqueName(taken: readonly string[], name: string): string {
  const used = new Set(taken.map((n) => n.normalize('NFC')))
  const base = name.normalize('NFC')
  if (!used.has(base)) return base
  const parts = graphemesOf(base)
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const room = PRESET_NAME_LIMIT - suffix.length
    const stem = (parts.length > room ? parts.slice(0, room).join('') : base).trimEnd()
    const candidate = `${stem}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** A new id no preset in `store` has (built-in ids have no colon, so they never collide). */
function freshId(store: UserPresetStore, random: () => number): string {
  const ids = new Set(store.presets.map((p) => p.id))
  let id = newPresetId(random)
  // A random source that keeps repeating itself still ends: the next ids counted from it.
  for (let n = parseInt(id.slice(5), 16); ids.has(id); ) {
    n = (n + 1) % 2 ** 48
    id = `user:${n.toString(16).padStart(12, '0')}`
  }
  return id
}

/** A preset of `options` and `bundle` under `name` (made unique among `taken`), or null when the name is empty once cleaned. */
function makePreset(
  store: UserPresetStore,
  taken: readonly string[],
  name: string,
  options: ExportOptions,
  bundle: Omit<BundleOptions, 'languages'> | undefined,
  now: number,
  random: () => number
): UserExportPreset | null {
  const clean = cleanPresetName(name)
  if (!clean) return null
  const preset: UserExportPreset = {
    id: freshId(store, random),
    name: uniqueName(taken, clean),
    options: keptOptions(options),
    saved: Number.isFinite(now) && now >= 0 ? Math.floor(now) : 0
  }
  const b = keptBundle(bundle)
  if (b) preset.bundle = b
  return preset
}

/** The store with a new preset `name` of `options` and `bundle`, after the others; unchanged at the limit of 50 or for an empty name. */
export function savePreset(store: UserPresetStore, name: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> | undefined, now: number, random: () => number): UserPresetStore {
  if (store.presets.length >= USER_PRESET_LIMIT) return store
  const taken = store.presets.map((p) => p.name)
  const preset = makePreset(store, taken, name, options, bundle, now, random)
  return preset ? { version: 1, presets: [...store.presets, preset] } : store
}

/** The store with preset `id` renamed (kept unique among the others); unchanged for an unknown id or an empty name. */
export function renamePreset(store: UserPresetStore, id: string, name: string): UserPresetStore {
  const clean = cleanPresetName(name)
  const at = store.presets.findIndex((p) => p.id === id)
  if (!clean || at < 0) return store
  const others = store.presets.filter((p) => p.id !== id).map((p) => p.name)
  const presets = store.presets.slice()
  presets[at] = { ...presets[at], name: uniqueName(others, clean) }
  return { version: 1, presets }
}

/** The store with preset `id` holding `options` and `bundle` (its name, id, save time and place kept); unchanged for an unknown id. */
export function updatePreset(store: UserPresetStore, id: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> | undefined): UserPresetStore {
  const at = store.presets.findIndex((p) => p.id === id)
  if (at < 0) return store
  const { id: keptId, name, saved } = store.presets[at]
  const next: UserExportPreset = { id: keptId, name, options: keptOptions(options), saved }
  const b = keptBundle(bundle)
  if (b) next.bundle = b
  const presets = store.presets.slice()
  presets[at] = next
  return { version: 1, presets }
}

/** The store without preset `id`. */
export function deletePreset(store: UserPresetStore, id: string): UserPresetStore {
  return { version: 1, presets: store.presets.filter((p) => p.id !== id) }
}

/**
 * The store with `incoming` (a preset file's presets, read by readPresetFile) added after the others
 * under new ids, free names and `now`, up to the limit of 50; `skipped` counts the ones left out over
 * it. A preset whose name is empty once cleaned is left out and not counted.
 */
export function importPresets(store: UserPresetStore, incoming: readonly UserExportPreset[], now: number, random: () => number): { store: UserPresetStore; added: number; skipped: number } {
  let next = store
  let added = 0
  let skipped = 0
  for (const p of incoming) {
    if (!cleanPresetName(p?.name)) continue
    if (next.presets.length >= USER_PRESET_LIMIT) {
      skipped++
      continue
    }
    const taken = next.presets.map((q) => q.name)
    const preset = makePreset(next, taken, p.name, p.options, p.bundle, now, random)
    if (!preset) continue
    next = { version: 1, presets: [...next.presets, preset] }
    added++
  }
  return { store: next, added, skipped }
}

/** Codec names as a suggested preset name spells them (technical names, §9.7). */
const NAME_CODECS: Readonly<Record<ExportCodec, string>> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  cineform: 'CineForm',
  animation: 'Lossless',
  'prores-422': 'ProRes 422',
  'prores-4444': 'ProRes 4444'
}

/**
 * A name built from the settings, for the Save as preset field: the format, the codec when it is not
 * the format's default, the size and rate, and the shape when it is not the project's own:
 * "MOV CineForm 1080p30", "MP4 4K60", "MP4 1080p30 4:5", "GIF 720p", "WAV".
 */
export function suggestName(o: ExportOptions): string {
  const format = FORMAT_LABELS[o.format]
  if (o.format === 'm4a' || o.format === 'wav') return format
  const parts = [format]
  const codec = codecOf(o)
  const standard = DEFAULT_CODEC[o.format]
  if (standard && codec !== standard) parts.push(NAME_CODECS[codec])
  const size = o.resolution === 2160 ? '4K' : `${o.resolution}p`
  parts.push(o.format === 'gif' ? size : `${size}${o.fps}`)
  if (o.aspect && o.aspect !== 'auto') parts.push(o.aspect)
  return parts.join(' ')
}
