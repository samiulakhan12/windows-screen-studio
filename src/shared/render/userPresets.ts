/**
 * The user's saved export presets and the `.flownpreset` file (docs/design/output-and-languages.md
 * §2.2, §4.4, §4.5, §18.2). Pure. A preset file may come from anyone, and editor-prefs.json may be
 * edited by hand, so both are read through these readers: only known keys and values pass, every
 * limit holds, and nothing in a preset is a path, a URL or code.
 *
 * Frozen by the contracts (§21.0) with test 5; part P5 edits presets through userPresetsEdit.ts.
 */
import type { PresetFileRead } from '../api/export'
import type { ExportCodec } from '../types'
import { normalizeBundle, type BundleOptions } from './exportBundle'
import { normalizeOptions, USER_PRESET_ID, type ExportOptions } from './exportPresets'
import { codecOf, isIntermediate } from './proFormats'

/** Most presets a user keeps, and most a file holds. */
export const USER_PRESET_LIMIT = 50
/** Largest preset file, in bytes of UTF-8. */
export const PRESET_FILE_LIMIT = 65536
/** Longest preset name, in graphemes. */
export const PRESET_NAME_LIMIT = 60

export interface UserExportPreset {
  /** 'user:' + 12 lower-case hex digits; never a built-in id (they have no colon). */
  id: string
  /** 1..60 graphemes, NFC, trimmed; no control, bidi-control or private-use characters (ZWJ and ZWNJ kept). */
  name: string
  /** Through normalizeOptions, without `preset`, `userPreset` and a target size where Target size is off. */
  options: ExportOptions
  /** The "Also save" choices, through normalizeBundle, never the subtitle languages. */
  bundle?: Omit<BundleOptions, 'languages'>
  /** When it was saved, ms since 1970. */
  saved: number
}

/** The `exportPresets` preference. */
export interface UserPresetStore {
  version: 1
  presets: UserExportPreset[]
}

/** What a preset file says it is. */
const FILE_KIND = 'export-presets'

/**
 * Characters a name never keeps: C0 and C1 controls, the bidi controls (ALM, LRM, RLM, the embeddings
 * and overrides, the isolates), private-use characters, path separators and lone surrogates. ZWJ and
 * ZWNJ (U+200D, U+200C) are kept: Bangla needs them.
 */
const DROPPED = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩-\\/]|[\udb80-\udbff][\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Enough code units for 60 graphemes of any script: a longer raw name is cut before it is read. */
const RAW_NAME_LIMIT = 4096

let graphemes: Intl.Segmenter | null = null
const segmentsOf = (s: string): string[] => {
  graphemes ??= new Intl.Segmenter('en', { granularity: 'grapheme' })
  return Array.from(graphemes.segment(s), (x) => x.segment)
}

/**
 * A preset name as Flown keeps it, or null when nothing is left: NFC, the dropped characters removed,
 * runs of white space made one space, trimmed, and cut to 60 graphemes. য় typed as U+09DF and as
 * য + ় give the same name.
 */
export function cleanPresetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw.slice(0, RAW_NAME_LIMIT).normalize('NFC').replace(DROPPED, '').replace(/\s+/gu, ' ').trim()
  if (!clean) return null
  const parts = segmentsOf(clean)
  const name = (parts.length > PRESET_NAME_LIMIT ? parts.slice(0, PRESET_NAME_LIMIT).join('') : clean).trim()
  return name || null
}

/**
 * Options as a preset keeps them: read like stored settings, without the ids of the presets they came
 * from, and without a target size where Target size is off (WAV, the editing formats, transparent
 * videos; §2.1), as the dialog's picks drop it.
 */
function presetOptions(raw: unknown, onCodecChange?: (from: ExportCodec, to: ExportCodec) => void): ExportOptions {
  const o = normalizeOptions(raw, onCodecChange)
  delete o.preset
  delete o.userPreset
  if (o.format === 'wav' || isIntermediate(codecOf(o)) || o.alpha) delete o.targetSizeMB
  return o
}

/** A preset's "Also save" choices without the subtitle languages, or undefined when it has none. */
function presetBundle(raw: unknown): Omit<BundleOptions, 'languages'> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const b = normalizeBundle(raw)
  delete b.languages
  return b
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The `exportPresets` preference, or null when it is malformed: presets that cannot be read are left out, at most 50, each id once. */
export function readUserPresets(raw: unknown): UserPresetStore | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.presets)) return null
  const presets: UserExportPreset[] = []
  const ids = new Set<string>()
  for (const item of raw.presets.slice(0, USER_PRESET_LIMIT * 4)) {
    if (presets.length >= USER_PRESET_LIMIT) break
    if (!isRecord(item)) continue
    const id = item.id
    const name = cleanPresetName(item.name)
    if (typeof id !== 'string' || !USER_PRESET_ID.test(id) || ids.has(id) || !name || !isRecord(item.options)) continue
    ids.add(id)
    const preset: UserExportPreset = { id, name, options: presetOptions(item.options), saved: 0 }
    const bundle = presetBundle(item.bundle)
    if (bundle) preset.bundle = bundle
    preset.saved = typeof item.saved === 'number' && Number.isFinite(item.saved) && item.saved >= 0 ? Math.floor(item.saved) : 0
    presets.push(preset)
  }
  return { version: 1, presets }
}

/** UTF-8 bytes of `text`. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * A `.flownpreset` file's presets, or null when it is not one (§4.5, §18.2): at most 64 KB, `flown`
 * and `version` as written, at most 50 presets (the rest counted in `skipped`), names cleaned,
 * options and bundles read like stored ones with each codec change counted, every other field
 * dropped. The presets carry no id and no save time yet (id '' and saved 0): importing makes them.
 */
export function readPresetFile(text: string): PresetFileRead | null {
  if (typeof text !== 'string' || text.length > PRESET_FILE_LIMIT || utf8Bytes(text) > PRESET_FILE_LIMIT) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.flown !== FILE_KIND || raw.version !== 1 || !Array.isArray(raw.presets)) return null
  const presets: UserExportPreset[] = []
  const changes = new Map<string, { from: ExportCodec; to: ExportCodec; count: number }>()
  let skipped = 0
  for (const item of raw.presets) {
    if (!isRecord(item) || !isRecord(item.options)) continue
    const name = cleanPresetName(item.name)
    if (!name) continue
    if (presets.length >= USER_PRESET_LIMIT) {
      skipped++
      continue
    }
    const options = presetOptions(item.options, (from, to) => {
      const key = `${from}>${to}`
      const c = changes.get(key)
      if (c) c.count++
      else changes.set(key, { from, to, count: 1 })
    })
    const preset: UserExportPreset = { id: '', name, options, saved: 0 }
    const bundle = presetBundle(item.bundle)
    if (bundle) preset.bundle = bundle
    presets.push(preset)
  }
  return { presets, skipped, changed: [...changes.values()] }
}

/** The text of a `.flownpreset` file holding `presets`: names, options and bundles only (ids and save times are made again on import). */
export function presetFileText(presets: readonly UserExportPreset[]): string {
  const file = {
    flown: FILE_KIND,
    version: 1,
    presets: presets.map((p) => (p.bundle ? { name: p.name, options: p.options, bundle: p.bundle } : { name: p.name, options: p.options }))
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** A new user preset id from `random` (values in [0, 1)): 'user:' and 12 lower-case hex digits. */
export function newPresetId(random: () => number): string {
  let hex = ''
  for (let i = 0; i < 12; i++) {
    const r = random()
    const v = Number.isFinite(r) ? Math.min(15, Math.max(0, Math.floor(r * 16))) : 0
    hex += v.toString(16)
  }
  return `user:${hex}`
}
