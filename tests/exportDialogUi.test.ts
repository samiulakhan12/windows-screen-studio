import { describe, expect, it } from 'vitest'
import type { BundleOptions } from '../src/shared/render/exportBundle'
import type { ExportOptions } from '../src/shared/render/exportPresets'
import type { CodecUiCaps } from '../src/shared/render/exportRows'
import type { UserExportPreset, UserPresetStore } from '../src/shared/render/userPresets'
import type { ExportFormat } from '../src/shared/types'

/*
 * The export dialog's wave 12 controls as they render (docs/design/output-and-languages.md §2.1-2.3,
 * §2.8, part P5): radio groups for Codec, Background and Frame rate with visible reasons, Also save's
 * Sound stems and Timeline with their rows, the saved preset cards with their More button beside the
 * card, the name field and the import notices. Rendered to markup, as the runtime tests render <T>.
 */

const React = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const ROWS = '../src/renderer/src/editor/exportRows'
const BUNDLE = '../src/renderer/src/editor/ExportBundleOptions'
const PRESETS = '../src/renderer/src/editor/UserPresets'
type Component = (props: Record<string, unknown>) => unknown
const rowsUi = (await import(/* @vite-ignore */ ROWS)) as Record<'CodecRow' | 'BackgroundRow' | 'FrameRateRow', Component>
const { ExportBundleOptions } = (await import(/* @vite-ignore */ BUNDLE)) as { ExportBundleOptions: Component }
const presetsUi = (await import(/* @vite-ignore */ PRESETS)) as Record<'UserPresets' | 'SavePresetField', Component> & {
  importNotices: (read: unknown, added: number, skipped: number) => { text: string; warn: boolean }[]
}
const { settingsRows } = await import('../src/shared/render/exportRows')

const html = (c: Component, props: Record<string, unknown>): string => renderToStaticMarkup(React.createElement(c as never, props))
const o = (format: ExportFormat, extra: Partial<ExportOptions> = {}): ExportOptions => ({ format, resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', ...extra })
const caps = (hevc: CodecUiCaps['hevc']): CodecUiCaps => ({ hevc, av1Gpu: false, h264Gpu: false })
const CTX = { seeThrough: true, size: { width: 1920, height: 1080 }, seconds: 60 }
const rowsOf = (opts: ExportOptions, c = caps('none')) => settingsRows(opts, c, CTX)
const noop = (): void => undefined

describe('the Codec, Background and Frame rate rows', () => {
  it('render radio groups named by their row label, the chosen chip checked and alone in the tab order', () => {
    const values = { names: '', size: '1 MB', time: '6 min', length: '1 min' }
    const codec = html(rowsUi.CodecRow, { rows: rowsOf(o('mp4', { codec: 'av1' })), options: o('mp4', { codec: 'av1' }), onChange: noop, hintValues: values })
    expect(codec).toContain('<span id="export-codec-label">Codec</span>')
    expect(codec).toContain('role="radiogroup" aria-labelledby="export-codec-label"')
    expect(codec).toMatch(/role="radio" aria-checked="true" data-value="av1" tabindex="0"/)
    expect(codec).toMatch(/role="radio" aria-checked="false" data-value="h264" tabindex="-1"/)
    expect(codec).toContain('title="Plays everywhere"')
    expect(codec).toContain('>H.264<')
    expect(codec).toContain('AV1 on the processor takes about 6 times as long as H.264: roughly 6 min for this video.')
    // MP4 and GIF have no Background row; GIF and the audio formats no Codec row.
    expect(html(rowsUi.BackgroundRow, { rows: rowsOf(o('mp4')), options: o('mp4'), onChange: noop })).toBe('')
    expect(html(rowsUi.CodecRow, { rows: rowsOf(o('gif')), options: o('gif'), onChange: noop })).toBe('')
    const bg = html(rowsUi.BackgroundRow, { rows: rowsOf(o('webm', { alpha: 'overlays' })), options: o('webm', { alpha: 'overlays' }), onChange: noop })
    expect(bg).toContain('>Background<')
    expect(bg).toMatch(/aria-checked="true" data-value="overlays"/)
    expect(bg).toContain('Plays transparent in Chrome, Edge and Firefox (WebM), and in editing software (MOV). Safari shows WebM on black.')
  })

  it('say why a chip is disabled in visible text under the row, and name the notice’s codecs', () => {
    const probing = html(rowsUi.CodecRow, { rows: rowsOf(o('mov'), caps('probing')), options: o('mov'), onChange: noop })
    expect(probing).toMatch(/data-value="hevc" tabindex="-1" class="chip " title="Checking for an HEVC encoder…" disabled=""/)
    expect(probing).toContain('<p class="hint">Checking for an HEVC encoder…</p>')
    const stored = o('mp4', { codec: 'hevc' })
    const none = html(rowsUi.CodecRow, { rows: rowsOf(stored), options: o('mp4'), onChange: noop, noticeValues: { codec: 'HEVC', fallback: 'H.264' } })
    expect(none).toContain('This PC cannot make HEVC, so this export uses H.264.')
    expect(none).not.toContain('data-value="hevc"')
    const fps = html(rowsUi.FrameRateRow, { rows: rowsOf(o('mp4', { resolution: 2160 })), options: o('mp4', { resolution: 2160 }), onChange: noop })
    expect(fps).toContain('role="radiogroup" aria-labelledby="export-fps-label"')
    expect(fps.match(/role="radio"/g)).toHaveLength(5)
    expect(fps).toMatch(/data-value="120" tabindex="-1" class="chip " title="H.264 cannot carry 4K at 120 fps. Choose HEVC or AV1, or 1440p." disabled=""/)
    expect(fps).toContain('<p class="hint">H.264 cannot carry 4K at 120 fps. Choose HEVC or AV1, or 1440p.</p>')
    expect(fps).toContain('title="The film rate. Scrolling looks less smooth than at 30"')
    // 30 and 60 fps keep no title, as before.
    expect(fps).toMatch(/aria-checked="true" data-value="30" tabindex="0" class="chip active">30 fps</)
    const plain = html(rowsUi.FrameRateRow, { rows: rowsOf(o('mp4')), options: o('mp4'), onChange: noop })
    expect(plain.startsWith('<div class="chips" role="radiogroup"')).toBe(true)
  })
})

describe('Also save: Sound stems and Timeline', () => {
  const NONE: BundleOptions = { srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false }
  const has = { captions: false, chapters: true }
  const also = (options: ExportOptions, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ options, hasSound: true, stems: ['voice', 'system', 'music'], seconds: 60, notEvened: false, ...extra })
  const render = (value: BundleOptions, alsoSave?: Record<string, unknown>, mode = 'single'): string => html(ExportBundleOptions, { value, onChange: noop, format: (alsoSave?.options as ExportOptions | undefined)?.format ?? 'mp4', has, mode, chapterCount: 2, alsoSave })

  it('adds nothing without the export’s context, so the row reads as before', () => {
    expect(render(NONE)).not.toContain('data-also')
  })

  it('adds the two chips at the end of the row with their titles, and lists the stems when on', () => {
    const off = render(NONE, also(o('mp4')))
    expect(off).toContain('data-also="stems"')
    expect(off).toContain('title="One 32-bit float WAV file per sound, to mix in other software: voice, system sound, music and effects"')
    expect(off).toContain('title="A timeline for DaVinci Resolve, Premiere Pro or Final Cut Pro, with chapter markers"')
    expect(off.indexOf('data-sidecar="description"')).toBeLessThan(off.indexOf('data-also="stems"'))
    const on = render({ ...NONE, stems: true }, also(o('mp4'), { notEvened: true }))
    expect(on).toMatch(/aria-pressed="true"[^>]*data-also="stems"/)
    expect(on).toContain('Saves Voice, System sound and Music (32-bit float WAV, about 23.0 MB each).')
    expect(on).toContain("The stems are not evened out like the video&#x27;s sound, so their level can differ a little.")
  })

  it('says why they are off: a silent video, audio files, batches', () => {
    expect(render({ ...NONE, stems: true }, also(o('mp4'), { hasSound: false }))).toContain('This video has no sound.')
    const m4a = render(NONE, also(o('m4a')))
    expect(m4a).toContain('Timelines need a video.')
    expect(m4a).toMatch(/data-also="stems"/)
    expect(m4a).not.toMatch(/disabled=""[^>]*data-also="stems"/)
    expect(render(NONE, also(o('mp4')), 'batch')).toContain('Stems and timelines work with One file.')
    // GIFs already say they are saved alone.
    expect(render(NONE, also(o('gif')))).not.toContain('GIFs are saved alone. GIFs')
  })

  it('shows Open in and Uses with Timeline on: Final Cut Pro blocked for VP9, the unchecked line, the EDL blocked with the recordings', () => {
    const webm = render({ ...NONE, timelines: ['resolve', 'finalcut'] }, also(o('webm')))
    expect(webm).toContain('>Open in<')
    expect(webm).toMatch(/disabled=""[^>]*data-editor="finalcut"/)
    expect(webm).toContain('Final Cut Pro cannot open VP9 files. Choose H.264 or HEVC.')
    expect(webm).toContain('Not checked yet with DaVinci Resolve: it may not open VP9 files.')
    expect(webm).toContain('The finished video and its sound, with chapter markers. Looks the same in every editor.')
    const recordings = render({ ...NONE, timelines: ['premiere', 'edl'], timelineMedia: 'recordings' }, also(o('mp4')))
    expect(recordings).toContain('An EDL can hold the finished video only. Choose This export.')
    expect(recordings).toContain('Speed changes may change the pitch in Premiere Pro.')
    expect(recordings).toMatch(/type="radio"[^>]*data-media="recordings" checked=""/)
    expect(render(NONE, also(o('mp4')))).not.toContain('>Open in<')
  })
})

describe('saved presets', () => {
  const store = (presets: UserExportPreset[]): UserPresetStore => ({ version: 1, presets })
  const preset = (name: string, id = 'user:0123456789ab'): UserExportPreset => ({ id, name, options: o('mov', { codec: 'cineform' }), saved: 1 })
  const props = (s: UserPresetStore, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    store: s,
    selected: null,
    options: o('mp4'),
    bundle: { srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false },
    onPick: noop,
    onStore: noop,
    metaOf: () => 'MOV · CineForm · 1080p30',
    ...extra
  })

  it('shows nothing without presets, and with them a heading, radio cards and a More button beside each card', () => {
    expect(html(presetsUi.UserPresets, props(store([])))).toBe('')
    const out = html(presetsUi.UserPresets, props(store([preset('Client review'), preset('ভিডিও', 'user:0123456789ac')]), { selected: 'user:0123456789ac' }))
    expect(out).toContain('<span id="user-presets-heading">Your presets</span>')
    expect(out).toContain('role="radiogroup" aria-labelledby="user-presets-heading"')
    expect(out).toMatch(/role="radio" aria-checked="true" data-preset="user:0123456789ac"/)
    expect(out).toContain('aria-label="More for Client review"')
    expect(out).toContain('aria-haspopup="menu"')
    expect(out).toContain('MOV · CineForm · 1080p30')
    // Never a button inside a button.
    expect(out).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/s)
    const batch = html(presetsUi.UserPresets, props(store([preset('A')]), { batch: { checked: ['user:0123456789ab'], onToggle: noop } }))
    expect(batch).toMatch(/role="checkbox" aria-checked="true"/)
  })

  it('opens the name field with a free suggestion, labelled "Preset name"', () => {
    const out = html(presetsUi.SavePresetField, { suggestion: 'MOV CineForm 1080p30', taken: ['MOV CineForm 1080p30'], onSave: noop, onCancel: noop })
    expect(out).toContain('<span>Preset name</span>')
    expect(out).toContain('placeholder="Preset name"')
    expect(out).toContain('value="MOV CineForm 1080p30 (2)"')
    expect(out).toContain('data-own-escape="true"')
    expect(out).toContain('>Save<')
    expect(out).toContain('>Cancel<')
  })

  it('says what an import did, in the exact words of §2.2', () => {
    const read = (presets: number, skipped = 0, changed: { from: string; to: string; count: number }[] = []) => ({ presets: Array.from({ length: presets }, () => preset('x')), skipped, changed })
    expect(presetsUi.importNotices(read(1), 1, 0).map((n) => n.text)).toEqual(['Imported 1 preset.'])
    expect(presetsUi.importNotices(read(3), 3, 0).map((n) => n.text)).toEqual(['Imported 3 presets.'])
    expect(presetsUi.importNotices(read(0), 0, 0).map((n) => n.text)).toEqual(['This file has no presets Flown can read.'])
    expect(presetsUi.importNotices({ refused: 'unreadable' }, 0, 0).map((n) => n.text)).toEqual(['This file has no presets Flown can read.'])
    expect(presetsUi.importNotices({ refused: 'too-large' }, 0, 0).map((n) => n.text)).toEqual(['This file is too large to be a Flown preset file.'])
    expect(presetsUi.importNotices(read(5, 2), 2, 1).map((n) => n.text)).toEqual(['Imported 2 presets.', 'You can keep 50 presets, so 3 were not imported.'])
    expect(presetsUi.importNotices(read(2, 0, [{ from: 'prores-422', to: 'cineform', count: 2 }]), 2, 0).map((n) => n.text)).toEqual([
      'Imported 2 presets.',
      '2 presets use ProRes, which Flown does not make: they export as MOV with CineForm.'
    ])
  })
})
