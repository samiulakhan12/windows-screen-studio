import { describe, expect, it } from 'vitest'
import type { SoundStem, TimelineEditor } from '../src/shared/api/export'
import type { BundleOptions } from '../src/shared/render/exportBundle'
import type { ExportOptions } from '../src/shared/render/exportPresets'
import type { ExportCodec, ExportFormat } from '../src/shared/types'

/*
 * Part P5 of output and the app (docs/design/output-and-languages.md §2.2, §2.3, §21.5): the user's
 * presets as data (test 45) and when Also save's sound stems and timelines are blocked (test 48).
 */

const edit = await import('../src/shared/render/userPresetsEdit')
const { readUserPresets, readPresetFile, presetFileText, USER_PRESET_LIMIT } = await import('../src/shared/render/userPresets')
const { EXPORT_PRESETS } = await import('../src/shared/render/exportPresets')
const also = await import('../src/shared/render/alsoSave')
const { FORMAT_CODECS } = await import('../src/shared/render/proFormats')

const EMPTY = { version: 1 as const, presets: [] }
const MOV: ExportOptions = { format: 'mov', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', codec: 'cineform' }
const BUNDLE: Omit<BundleOptions, 'languages'> = { srt: false, vtt: false, chapters: true, thumbnail: false, description: false, perChapter: false, stems: true }
/** A fixed random source: the same id each time, unless it steps. */
const fixed = (v: number) => (): number => v
let tick = 0
const stepping = (): number => ((tick = (tick + 0.137) % 1), tick)

describe('test 45: saving, renaming, updating, deleting and importing user presets', () => {
  it('saves a preset after the others with a user id, the time given, clean options and no subtitle languages', () => {
    const withIds: ExportOptions = { ...MOV, preset: 'youtube-1080', userPreset: 'user:00000000000a' }
    const bundle = { ...BUNDLE, languages: ['bn', 'en'] } as BundleOptions
    const store = edit.savePreset(EMPTY, '  Client   review ', withIds, bundle, 1_700_000_000_123.7, fixed(0.5))
    expect(store).not.toBe(EMPTY)
    expect(EMPTY.presets).toEqual([])
    expect(store.presets).toHaveLength(1)
    const [p] = store.presets
    expect(p.id).toMatch(/^user:[0-9a-f]{12}$/)
    expect(p.id).toBe('user:888888888888')
    expect(EXPORT_PRESETS.some((b) => b.id === p.id)).toBe(false)
    expect(p.name).toBe('Client review')
    expect(p.saved).toBe(1_700_000_000_123)
    expect(p.options).toEqual({ format: 'mov', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', codec: 'cineform' })
    expect(p.bundle).not.toHaveProperty('languages')
    expect(p.bundle).toMatchObject({ chapters: true, stems: true })
    // What the dialog stores reads back unchanged through main's reader.
    expect(readUserPresets(store)).toEqual(store)
  })

  it('makes a taken name unique with " (2)", " (3)", comparing NFC forms', () => {
    let store = edit.savePreset(EMPTY, 'Demo', MOV, undefined, 1, stepping)
    store = edit.savePreset(store, 'Demo', MOV, undefined, 2, stepping)
    store = edit.savePreset(store, 'Demo', MOV, undefined, 3, stepping)
    expect(store.presets.map((p) => p.name)).toEqual(['Demo', 'Demo (2)', 'Demo (3)'])
    expect(new Set(store.presets.map((p) => p.id)).size).toBe(3)
    // য় typed as one code point and as য + ়: one name.
    const composed = 'ভিডিয়ো'
    const decomposed = 'ভিডিয়ো'
    expect(edit.uniqueName([composed.normalize('NFC')], decomposed)).toBe(`${composed.normalize('NFC')} (2)`)
    expect(edit.uniqueName(['a', 'b'], 'c')).toBe('c')
    // A long name is shortened so the suffix fits in 60 graphemes.
    const long = 'x'.repeat(60)
    expect(edit.uniqueName([long], long)).toBe(`${'x'.repeat(56)} (2)`)
  })

  it('never saves a 51st preset, nor one with an empty name', () => {
    let store = EMPTY as { version: 1; presets: ReturnType<typeof edit.savePreset>['presets'] }
    for (let i = 0; i < USER_PRESET_LIMIT; i++) store = edit.savePreset(store, `P${i}`, MOV, undefined, i, stepping)
    expect(store.presets).toHaveLength(50)
    expect(edit.savePreset(store, 'One more', MOV, undefined, 99, stepping)).toBe(store)
    expect(edit.savePreset(EMPTY, ' ‮\u0000 ', MOV, undefined, 1, stepping)).toBe(EMPTY)
  })

  it('gives each preset its own id even when the random source repeats itself', () => {
    let store = edit.savePreset(EMPTY, 'A', MOV, undefined, 1, fixed(0))
    store = edit.savePreset(store, 'B', MOV, undefined, 1, fixed(0))
    expect(store.presets.map((p) => p.id)).toEqual(['user:000000000000', 'user:000000000001'])
  })

  it('renames, keeping the name unique among the others and the rest of the preset', () => {
    let store = edit.savePreset(EMPTY, 'A', MOV, BUNDLE, 1, stepping)
    store = edit.savePreset(store, 'B', MOV, undefined, 2, stepping)
    const [a, b] = store.presets
    const renamed = edit.renamePreset(store, b.id, 'A')
    expect(renamed.presets[1]).toEqual({ ...b, name: 'A (2)' })
    expect(edit.renamePreset(store, a.id, 'A').presets[0]).toEqual(a)
    expect(edit.renamePreset(store, a.id, '   ')).toBe(store)
    expect(edit.renamePreset(store, 'user:ffffffffffff', 'Z')).toBe(store)
  })

  it('updates the options and Also save choices in place, keeping name, id, save time and order', () => {
    let store = edit.savePreset(EMPTY, 'A', MOV, BUNDLE, 5, stepping)
    store = edit.savePreset(store, 'B', MOV, undefined, 6, stepping)
    const [a] = store.presets
    const next = edit.updatePreset(store, a.id, { ...MOV, fps: 60, codec: 'animation', userPreset: a.id }, undefined)
    expect(next.presets[0]).toEqual({ id: a.id, name: 'A', saved: 5, options: { ...MOV, fps: 60, codec: 'animation' } })
    expect(next.presets[1]).toBe(store.presets[1])
    const withLanguages = edit.updatePreset(store, a.id, MOV, { ...BUNDLE, languages: ['bn'] } as BundleOptions)
    expect(withLanguages.presets[0].bundle).not.toHaveProperty('languages')
  })

  it('deletes one preset and keeps the others in order', () => {
    let store = EMPTY as ReturnType<typeof edit.savePreset>
    for (const n of ['A', 'B', 'C']) store = edit.savePreset(store, n, MOV, undefined, 1, stepping)
    expect(edit.deletePreset(store, store.presets[1].id).presets.map((p) => p.name)).toEqual(['A', 'C'])
  })

  it('imports a file’s presets under new ids, free names and the import time, up to the limit', () => {
    let store = edit.savePreset(EMPTY, 'Client review', MOV, undefined, 1, stepping)
    const file = readPresetFile(presetFileText([{ id: '', name: 'Client review', options: MOV, bundle: BUNDLE, saved: 0 }, { id: '', name: 'Web', options: { ...MOV, format: 'mp4', codec: undefined }, saved: 0 }]))!
    const result = edit.importPresets(store, file.presets, 42, stepping)
    expect(result.added).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.store.presets.map((p) => p.name)).toEqual(['Client review', 'Client review (2)', 'Web'])
    for (const p of result.store.presets.slice(1)) {
      expect(p.id).toMatch(/^user:[0-9a-f]{12}$/)
      expect(p.saved).toBe(42)
    }
    expect(result.store.presets[1].bundle).toMatchObject({ stems: true })
    // Over the limit: the rest are counted, not added.
    for (let i = 1; i < 49; i++) store = edit.savePreset(store, `P${i}`, MOV, undefined, 1, stepping)
    expect(store.presets).toHaveLength(49)
    const full = edit.importPresets(store, file.presets, 43, stepping)
    expect([full.added, full.skipped, full.store.presets.length]).toEqual([1, 1, 50])
  })

  it('suggests a name from the settings', () => {
    expect(edit.suggestName(MOV)).toBe('MOV CineForm 1080p30')
    expect(edit.suggestName({ ...MOV, format: 'mp4', codec: undefined, resolution: 2160, fps: 60 })).toBe('MP4 4K60')
    expect(edit.suggestName({ ...MOV, format: 'mp4', codec: 'hevc', aspect: '4:5' })).toBe('MP4 HEVC 1080p30 4:5')
    expect(edit.suggestName({ ...MOV, format: 'gif', codec: undefined, resolution: 720 })).toBe('GIF 720p')
    expect(edit.suggestName({ ...MOV, format: 'wav', codec: undefined })).toBe('WAV')
  })
})

describe('test 48: when sound stems and timelines can be saved', () => {
  const o = (format: ExportFormat, codec?: ExportCodec): ExportOptions => ({ format, resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', ...(codec ? { codec } : {}) })

  it('blocks both for GIF, batch and one file per chapter, stems for a silent video and timelines for audio files', () => {
    expect(also.stemsBlocked(o('gif'), 'single', false, true)).toBe('stems.blocked.gif')
    expect(also.timelineBlocked(o('gif'), 'single', false)).toBe('stems.blocked.gif')
    expect(also.stemsBlocked(o('mp4'), 'batch', false, true)).toBe('stems.blocked.batch')
    expect(also.timelineBlocked(o('mp4'), 'batch', false)).toBe('stems.blocked.batch')
    expect(also.stemsBlocked(o('mp4'), 'single', true, true)).toBe('stems.blocked.perChapter')
    expect(also.timelineBlocked(o('mp4'), 'single', true)).toBe('stems.blocked.perChapter')
    expect(also.stemsBlocked(o('mp4'), 'single', false, false)).toBe('stems.blocked.silent')
    expect(also.stemsBlocked(o('mp4'), 'single', false, true)).toBeNull()
    expect(also.timelineBlocked(o('mp4'), 'single', false)).toBeNull()
    for (const f of ['m4a', 'wav'] as const) {
      expect(also.stemsBlocked(o(f), 'single', false, true)).toBeNull()
      expect(also.timelineBlocked(o(f), 'single', false)).toBe('timelines.blocked.needsVideo')
    }
    for (const f of ['mov', 'webm'] as const) expect([also.stemsBlocked(o(f), 'single', false, true), also.timelineBlocked(o(f), 'single', false)]).toEqual([null, null])
  })

  it('blocks Final Cut Pro for VP9 and AV1 exports, and the EDL with the original recordings', () => {
    expect(also.editorBlocked('finalcut', o('webm'), 'export')).toBe('timelines.blocked.finalcutCodec')
    expect(also.editorBlocked('finalcut', o('webm', 'av1'), 'export')).toBe('timelines.blocked.finalcutCodec')
    expect(also.editorBlocked('finalcut', o('mp4', 'av1'), 'export')).toBe('timelines.blocked.finalcutCodec')
    expect(also.editorBlocked('finalcut', o('mp4'), 'export')).toBeNull()
    expect(also.editorBlocked('finalcut', o('mp4', 'hevc'), 'export')).toBeNull()
    // The recordings' copies are H.264 and WAV, whatever the export is.
    expect(also.editorBlocked('finalcut', o('webm'), 'recordings')).toBeNull()
    expect(also.editorBlocked('edl', o('mp4'), 'recordings')).toBe('timelines.blocked.edlRecordings')
    expect(also.editorBlocked('edl', o('mp4'), 'export')).toBeNull()
    for (const e of ['resolve', 'premiere'] as const) expect(also.editorBlocked(e, o('webm'), 'export')).toBeNull()
  })

  it('warns for every pair EDITOR_OPENS has not checked yet, and only for those', () => {
    const editors: TimelineEditor[] = ['resolve', 'premiere', 'finalcut', 'edl']
    let warned = 0
    for (const editor of editors)
      for (const format of ['mp4', 'mov', 'webm'] as const)
        for (const codec of FORMAT_CODECS[format]) {
          const cell = also.EDITOR_OPENS[editor][codec]
          expect([editor, format, codec, also.editorWarning(editor, o(format, codec), 'export')]).toEqual([editor, format, codec, cell === 'unchecked' ? 'timelines.unchecked' : null])
          if (cell === 'unchecked') warned++
          expect(also.editorWarning(editor, o(format, codec), 'recordings')).toBeNull()
        }
    expect(warned).toBeGreaterThan(0)
    expect(also.editorWarning('finalcut', o('mov', 'cineform'), 'export')).toBe('timelines.unchecked')
    expect(also.editorWarning('premiere', o('mov', 'animation'), 'export')).toBe('timelines.unchecked')
  })

  it('writes one FCPXML for Resolve and Final Cut Pro together', () => {
    expect(also.timelineKindsFor(['resolve', 'finalcut'])).toEqual(['fcpxml'])
    expect(also.timelineKindsFor(['edl', 'premiere', 'resolve'])).toEqual(['fcpxml', 'xmeml', 'edl'])
    expect(also.timelineKindsFor([])).toEqual([])
  })

  it('says which stems are written and about how large each is', () => {
    const stems: SoundStem[] = ['voice', 'system', 'music']
    expect(also.stemsHint(stems, 60)).toBe('Saves Voice, System sound and Music (32-bit float WAV, about 23.0 MB each).')
    expect(also.stemsHint(['recording', 'music'], 10)).toBe('Saves Recording and Music (32-bit float WAV, about 3.8 MB each).')
    expect(also.stemsHint([], 10)).toBe('')
  })
})
