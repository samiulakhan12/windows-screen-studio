import { describe, expect, it } from 'vitest'
import type { CodecUiCaps } from '../src/shared/render/exportRows'
import type { ExportOptions } from '../src/shared/render/exportPresets'
import type { UserExportPreset } from '../src/shared/render/userPresets'
import type { ExportCodec, ExportFormat } from '../src/shared/types'

/*
 * Part P5 of output and the app (docs/design/output-and-languages.md §2.1, §2.2, §21.5): the export
 * dialog's rows as data (test 47), the size line (test 49), batches with user presets (test 46) and
 * the new destinations with the preset matching (test 50).
 */

const rows = await import('../src/shared/render/exportRows')
const presets = await import('../src/shared/render/exportPresets')
const { CODEC_POLICY } = await import('../src/shared/render/proFormats')

/** Runs `fn` with the codec policy switched, and switches it back. */
function withPolicy<T>(patch: Partial<typeof CODEC_POLICY>, fn: () => T): T {
  const before = { ...CODEC_POLICY }
  Object.assign(CODEC_POLICY, patch)
  try {
    return fn()
  } finally {
    Object.assign(CODEC_POLICY, before)
  }
}

const o = (format: ExportFormat, extra: Partial<ExportOptions> = {}): ExportOptions => ({ format, resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', ...extra })
const caps = (hevc: CodecUiCaps['hevc'], av1Gpu = false): CodecUiCaps => ({ hevc, av1Gpu, h264Gpu: false })
const CTX = { seeThrough: true, size: { width: 1920, height: 1080 }, seconds: 134 }
const chipsOf = (r: ReturnType<typeof rows.settingsRows>): { value: ExportCodec; disabled: string | null }[] => r.codec?.chips ?? []

describe('test 47: the settings rows', () => {
  it('shows the HEVC chip disabled while the probe runs, enabled when it found an encoder, and not at all when it found none', () => {
    const probing = rows.settingsRows(o('mp4'), caps('probing'), CTX)
    expect(chipsOf(probing).map((c) => [c.value, c.disabled])).toEqual([
      ['h264', null],
      ['hevc', 'codecs.hevc.probing'],
      ['av1', null]
    ])
    const found = rows.settingsRows(o('mp4'), caps(['hevc_nvenc']), CTX)
    expect(chipsOf(found).find((c) => c.value === 'hevc')).toEqual({ value: 'hevc', disabled: null })
    expect(chipsOf(rows.settingsRows(o('mp4'), caps('webcodecs'), CTX)).map((c) => c.value)).toContain('hevc')
    for (const none of ['none', []] as CodecUiCaps['hevc'][]) expect(chipsOf(rows.settingsRows(o('mov'), caps(none), CTX)).map((c) => c.value)).toEqual(['h264', 'cineform', 'animation'])
    // No Codec row without video codecs.
    for (const f of ['gif', 'm4a', 'wav'] as const) expect(rows.settingsRows(o(f), caps('none'), CTX).codec).toBeNull()
    // ProRes only with the owner's decision 2 (b).
    expect(withPolicy({ prores: true }, () => chipsOf(rows.settingsRows(o('mov'), caps('none'), CTX)).map((c) => c.value))).toEqual(['h264', 'cineform', 'animation', 'prores-422', 'prores-4444'])
    expect(withPolicy({ cineform: false }, () => chipsOf(rows.settingsRows(o('mov'), caps('none'), CTX)).map((c) => c.value))).toEqual(['h264', 'animation'])
  })

  it('turns stored HEVC into H.264 with its notice when the probe found nothing, and says a preset’s own line', () => {
    const stored = o('mp4', { codec: 'hevc', resolution: 2160, fps: 120 })
    const none = rows.usableCodec(stored, caps('none'))
    expect(none.notice).toBe('codecs.notice.cannotMake')
    // H.264 cannot carry 4K at 120 fps: the fallback exports at 60.
    expect(none.options).toEqual(o('mp4', { resolution: 2160, fps: 60 }))
    expect(rows.codecNotice(stored, none.options)).toEqual({ codec: 'HEVC', fallback: 'H.264' })
    const fromPreset = rows.usableCodec({ ...stored, userPreset: 'user:0123456789ab' }, caps('none'))
    expect(fromPreset.notice).toBe('presets.notice.cannotMake')
    // Found, or still probing: nothing changes and nothing is said.
    for (const c of [caps(['hevc_qsv']), caps('webcodecs'), caps('probing')]) expect(rows.usableCodec(stored, c)).toEqual({ options: stored, notice: null })
    // The row shows what will be made, and the notice under it.
    const r = rows.settingsRows(stored, caps('none'), CTX)
    expect(r.codec?.notice).toBe('codecs.notice.cannotMake')
    expect(r.encoder.softwareDisabled).toBeNull()
    expect(rows.usableCodec(o('mp4'), caps('none'))).toEqual({ options: o('mp4'), notice: null })
  })

  it('shows no Background row for MP4, and one for MOV and WebM', () => {
    expect(rows.settingsRows(o('mp4'), caps('none'), CTX).background).toBeNull()
    for (const f of ['mov', 'webm'] as const) expect(rows.settingsRows(o(f), caps('none'), CTX).background?.chips.map((c) => c.value)).toEqual(['with', 'background', 'overlays'])
    for (const f of ['gif', 'm4a', 'wav'] as const) expect(rows.settingsRows(o(f), caps('none'), CTX).background).toBeNull()
  })

  it('switches a codec that cannot be transparent in the same step and gives it back on With background', () => {
    const mov = rows.pickBackground(o('mov'), 'background', null)
    expect(mov).toEqual({ options: o('mov', { codec: 'cineform', alpha: 'background' }), replaced: 'h264' })
    expect(rows.pickBackground(mov.options, undefined, mov.replaced)).toEqual({ options: o('mov'), replaced: null })
    const hevc = rows.pickBackground(o('mov', { codec: 'hevc' }), 'overlays', null)
    expect(hevc).toEqual({ options: o('mov', { codec: 'cineform', alpha: 'overlays' }), replaced: 'hevc' })
    expect(rows.pickBackground(hevc.options, undefined, hevc.replaced).options).toEqual(o('mov', { codec: 'hevc' }))
    const webm = rows.pickBackground(o('webm', { codec: 'av1' }), 'background', null)
    expect(webm).toEqual({ options: o('webm', { alpha: 'background' }), replaced: 'av1' })
    expect(rows.pickBackground(webm.options, undefined, webm.replaced).options).toEqual(o('webm', { codec: 'av1' }))
    // Already transparent-capable: only the background changes, and the replaced codec is kept.
    expect(rows.pickBackground(webm.options, 'overlays', webm.replaced)).toEqual({ options: o('webm', { alpha: 'overlays' }), replaced: 'av1' })
    // With CineForm off, MOV switches to Lossless.
    expect(withPolicy({ cineform: false }, () => rows.pickBackground(o('mov'), 'background', null).options)).toEqual(o('mov', { codec: 'animation', alpha: 'background' }))
    // MP4 has no Background row: nothing to pick.
    expect(rows.pickBackground(o('mp4'), 'background', null)).toEqual({ options: o('mp4'), replaced: null })
    // A transparent export has no size target.
    expect(rows.pickBackground(o('webm', { targetSizeMB: 20 }), 'background', null).options).toEqual(o('webm', { alpha: 'background' }))
  })

  it('puts Background back to With background when the codec picked cannot carry it', () => {
    expect(rows.pickCodec(o('mov', { codec: 'cineform', alpha: 'overlays' }), 'h264')).toEqual(o('mov'))
    expect(rows.pickCodec(o('mov', { codec: 'cineform', alpha: 'overlays' }), 'animation')).toEqual(o('mov', { codec: 'animation', alpha: 'overlays' }))
    expect(rows.pickCodec(o('webm', { alpha: 'background' }), 'av1')).toEqual(o('webm', { codec: 'av1' }))
    // The default codec stores nothing; a codec the format has not is not picked.
    expect(rows.pickCodec(o('mp4', { codec: 'hevc' }), 'h264')).toEqual(o('mp4'))
    expect(rows.pickCodec(o('mp4'), 'cineform')).toEqual(o('mp4'))
    // HEVC runs on the graphics card only; an editing format has no size target.
    expect(rows.pickCodec(o('mp4', { encoder: 'software' }), 'hevc')).toEqual(o('mp4', { codec: 'hevc' }))
    expect(rows.pickCodec(o('mov', { targetSizeMB: 50 }), 'cineform')).toEqual(o('mov', { codec: 'cineform' }))
    // A tweak makes a destination Custom.
    expect(rows.pickCodec(presets.applyPreset({ encoder: 'auto' }, presets.presetById('youtube-1080')!), 'hevc').preset).toBeUndefined()
  })

  it('disables 120 fps for 4K with H.264, and picking 4K at 120 fps with H.264 sets 60', () => {
    const fk = rows.settingsRows(o('mp4', { resolution: 2160 }), caps('none'), CTX)
    expect(fk.fps.chips.map((c) => [c.value, c.disabled])).toEqual([
      [24, null],
      [25, null],
      [30, null],
      [60, null],
      [120, 'codecs.fps.no4k120']
    ])
    expect(fk.fps.reason).toBe('codecs.fps.no4k120')
    expect(rows.settingsRows(o('mp4', { resolution: 2160, codec: 'hevc' }), caps(['hevc_nvenc']), CTX).fps.reason).toBeNull()
    expect(rows.settingsRows(o('mp4', { resolution: 1440 }), caps('none'), CTX).fps.reason).toBeNull()
    expect(rows.pickResolution(o('mp4', { fps: 120 }), 2160)).toEqual(o('mp4', { resolution: 2160, fps: 60 }))
    expect(rows.pickResolution(o('mp4', { fps: 120, codec: 'av1' }), 2160)).toEqual(o('mp4', { resolution: 2160, fps: 120, codec: 'av1' }))
    expect(rows.pickResolution(o('mp4', { maxWidth: 720 }), 720)).toEqual(o('mp4', { resolution: 720 }))
    expect(rows.pickFps(o('mp4', { resolution: 2160 }), 120)).toEqual(o('mp4', { resolution: 2160 }))
    expect(rows.pickFps(o('mp4'), 24)).toEqual(o('mp4', { fps: 24 }))
    // Back to H.264 from HEVC at 4K120.
    expect(rows.pickCodec(o('mp4', { resolution: 2160, fps: 120, codec: 'hevc' }), 'h264')).toEqual(o('mp4', { resolution: 2160, fps: 60 }))
  })

  it('shows Best · High · Medium for the editing formats, hides Quality for Lossless and their Encoder row, and turns Target size off with its reason', () => {
    const cine = rows.settingsRows(o('mov', { codec: 'cineform' }), caps('none'), CTX)
    expect(cine.quality).toEqual({ labels: 'intermediate', hidden: false })
    expect(cine.targetSize.disabled).toBe('codecs.target.editing')
    expect(cine.encoder.hidden).toBe(true)
    expect(cine.codec?.hint).toBe('codecs.hint.cineform')
    expect(withPolicy({ prores: true }, () => rows.settingsRows(o('mov', { codec: 'prores-422' }), caps('none'), CTX).quality.labels)).toBe('intermediate')
    const lossless = rows.settingsRows(o('mov', { codec: 'animation' }), caps('none'), CTX)
    expect(lossless.quality.hidden).toBe(true)
    expect(lossless.codec?.hint).toBe('codecs.hint.animation')
    const transparent = rows.settingsRows(o('webm', { alpha: 'background' }), caps('none'), CTX)
    expect(transparent.targetSize.disabled).toBe('codecs.target.transparent')
    expect(transparent.background?.hint).toBe('alpha.hint.plays')
    expect(rows.settingsRows(o('webm', { alpha: 'background' }), caps('none'), { ...CTX, seeThrough: false }).background?.hint).toBe('alpha.hint.fills')
    expect(rows.settingsRows(o('wav'), caps('none'), CTX).targetSize.disabled).toBe('codecs.target.wav')
    expect(rows.settingsRows(o('wav'), caps('none'), CTX).quality.hidden).toBe(true)
    // Today's rows for today's settings.
    const today = rows.settingsRows(o('mp4'), caps('none'), CTX)
    expect([today.quality, today.targetSize, today.encoder, today.codec?.hint, today.codec?.notice, today.fps.reason]).toEqual([{ labels: 'delivery', hidden: false }, { disabled: null }, { hidden: false, softwareDisabled: null }, null, null, null])
    // HEVC: Software is disabled with its reason; AV1's hint follows the graphics card and the Encoder choice.
    expect(rows.settingsRows(o('mp4', { codec: 'hevc' }), caps(['hevc_nvenc']), CTX).encoder.softwareDisabled).toBe('codecs.encoder.hevcSoftware')
    expect(rows.settingsRows(o('mp4', { codec: 'hevc' }), caps(['hevc_nvenc']), CTX).codec?.hint).toBe('codecs.hint.hevcGpu')
    expect(rows.settingsRows(o('mp4', { codec: 'av1' }), caps('none', true), CTX).codec?.hint).toBe('codecs.hint.av1Gpu')
    expect(rows.settingsRows(o('mp4', { codec: 'av1' }), caps('none', false), CTX).codec?.hint).toBe('codecs.hint.av1Cpu')
    expect(rows.settingsRows(o('mp4', { codec: 'av1', encoder: 'software' }), caps('none', true), CTX).codec?.hint).toBe('codecs.hint.av1Cpu')
    expect(rows.encoderNames(['hevc_nvenc', 'hevc_qsv'])).toBe('NVENC, QSV')
    expect(rows.encoderNames('webcodecs')).toBe('WebCodecs')
  })

  it('picks a format and drops what it cannot carry', () => {
    expect(rows.pickFormat(o('mov', { codec: 'cineform', alpha: 'overlays' }), 'mp4')).toEqual(o('mp4'))
    expect(rows.pickFormat(o('mov', { codec: 'cineform', alpha: 'overlays' }), 'webm')).toEqual(o('webm', { alpha: 'overlays' }))
    expect(rows.pickFormat(o('mp4', { codec: 'av1' }), 'webm')).toEqual(o('webm', { codec: 'av1' }))
    expect(rows.pickFormat(o('mp4', { codec: 'hevc' }), 'mov')).toEqual(o('mov', { codec: 'hevc' }))
    expect(rows.pickFormat(o('mp4', { targetSizeMB: 20 }), 'wav')).toEqual(o('wav'))
    // As before for today's settings: the width limit cleared, GIFs at most 1080p.
    expect(rows.pickFormat(o('mp4', { resolution: 2160, maxWidth: 720, targetSizeMB: 20 }), 'gif')).toEqual(o('gif', { targetSizeMB: 20 }))
    expect(rows.pickFormat(o('mp4', { targetSizeMB: 20 }), 'm4a')).toEqual(o('m4a', { targetSizeMB: 20 }))
  })
})

describe('test 49: the size line', () => {
  it('adds the codec only when it is not the format’s default', () => {
    const size = { width: 1080, height: 1350 }
    expect(rows.sizeLine(o('mp4', { codec: 'hevc' }), size, 134)).toBe('1080×1350 · 30 fps · HEVC · 2 min 14 s')
    expect(rows.sizeLine(o('mp4'), size, 134)).toBe('1080×1350 · 30 fps · 2 min 14 s')
    expect(rows.sizeLine(o('webm'), size, 45)).toBe('1080×1350 · 30 fps · 45 s')
    expect(rows.sizeLine(o('webm', { codec: 'av1' }), size, 45)).toBe('1080×1350 · 30 fps · AV1 · 45 s')
    expect(rows.sizeLine(o('mov', { codec: 'cineform', fps: 60 }), { width: 1920, height: 1080 }, 120)).toBe('1920×1080 · 60 fps · CineForm · 2 min')
    // GIFs play at 15 fps, as the line has always said.
    expect(rows.sizeLine(o('gif'), { width: 720, height: 406 }, 10)).toBe('720×406 · 15 fps · 10 s')
  })
})

const user = (name: string, options: ExportOptions, id = 'user:0123456789ab'): UserExportPreset => ({ id, name, options, saved: 1 })

describe('test 46: batches with user presets', () => {
  it('names each user preset’s file "{project} - {preset name}.{ext}" through safeFileName, a Bangla name staying Bangla', () => {
    const mine = [user('Client: review?', o('mov', { codec: 'cineform' })), user('ভিডিও রিভিউ', o('webm'), 'user:0123456789ac')]
    const items = presets.batchItems(['youtube-1080'], ['4:5'], o('mp4'), mine)
    expect(items.map((i) => i.key)).toEqual(['user:0123456789ab', 'user:0123456789ac', 'youtube-1080', 'aspect:4:5'])
    expect(items[0].options).toEqual(o('mov', { codec: 'cineform' }))
    expect(items[1].label).toBe('ভিডিও রিভিউ')
    expect(presets.batchFileNames('Demo', items)).toEqual(['Demo - Client- review-.mov', 'Demo - ভিডিও রিভিউ.webm', 'Demo - YouTube 1080p60.mp4', 'Demo - 1080p 4x5.mp4'])
    expect(items[3].options.aspect).toBe('4:5')
  })

  it('names destinations’ files from EXPORT_PRESET_FILE_LABELS, today’s labels, whatever the cards say', () => {
    for (const p of presets.EXPORT_PRESETS) expect(presets.EXPORT_PRESET_FILE_LABELS[p.id]).toBe(p.label)
    expect(presets.batchItems(['portrait-post'], [], o('mp4'))[0].fileLabel).toBe('Portrait post')
    expect(presets.BATCH_ASPECTS).toEqual(['16:9', '9:16', '1:1', '4:3', '4:5'])
    expect(presets.aspectFileLabel('4:5')).toBe('4x5')
  })
})

describe('test 50: the new destinations and preset matching', () => {
  it('gives the Portrait post, For editing and Transparent overlay settings', () => {
    const portrait = presets.applyPreset({ encoder: 'auto' }, presets.presetById('portrait-post')!)
    expect(portrait).toEqual({ format: 'mp4', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', preset: 'portrait-post', aspect: '4:5' })
    expect(presets.applyPreset({ encoder: 'auto' }, presets.presetById('editing')!)).toEqual({ format: 'mov', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto', preset: 'editing', codec: 'cineform' })
    expect(presets.applyPreset({ encoder: 'auto' }, presets.presetById('overlay')!)).toEqual({ format: 'mov', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto', preset: 'overlay', codec: 'cineform', alpha: 'overlays' })
    const ids = presets.shownPresets().map((p) => p.id)
    expect(ids.indexOf('portrait-post')).toBe(ids.indexOf('square') + 1)
    expect(ids.slice(ids.indexOf('email') + 1)).toEqual(['editing', 'overlay'])
  })

  it('hides For editing and Transparent overlay while CineForm is off', () => {
    withPolicy({ cineform: false }, () => {
      expect(presets.shownPresets().map((p) => p.id)).not.toContain('editing')
      expect(presets.shownPresets().map((p) => p.id)).not.toContain('overlay')
      expect(presets.presetById('editing')).toBeUndefined()
      expect(presets.batchItems(['editing', 'portrait-post'], [], o('mp4')).map((i) => i.key)).toEqual(['portrait-post'])
    })
    expect(presets.presetById('editing')).toBeDefined()
  })

  it('keeps each destination selected through a read and an unchanged tweak, and drops it on any change, a codec or background included', () => {
    for (const id of ['portrait-post', 'editing', 'overlay']) {
      const p = presets.presetById(id)!
      const opts = presets.applyPreset({ encoder: 'auto' }, p)
      expect(presets.matchesPreset(opts, p), id).toBe(true)
      expect(presets.normalizeOptions(JSON.parse(JSON.stringify(opts))).preset, id).toBe(id)
      expect(presets.tweakOptions(opts, { encoder: 'software' }).preset, id).toBe(id)
      expect(presets.tweakOptions(opts, { fps: 30 === opts.fps ? 60 : 30 }).preset, id).toBeUndefined()
    }
    const editing = presets.applyPreset({ encoder: 'auto' }, presets.presetById('editing')!)
    expect(presets.tweakOptions(editing, { codec: 'animation' }).preset).toBeUndefined()
    expect(presets.tweakOptions(editing, { alpha: 'background' }).preset).toBeUndefined()
    expect(presets.tweakOptions(presets.applyPreset({ encoder: 'auto' }, presets.presetById('overlay')!), { alpha: undefined }).preset).toBeUndefined()
  })

  it('keeps a colleague’s HEVC preset selected on a PC that exports it as H.264, and its batch row flags it', () => {
    const hevc = user('Colleague', o('mp4', { codec: 'hevc', fps: 60 }))
    const noHevc = rows.usableHere(caps('none'))
    const withHevc = rows.usableHere(caps(['hevc_amf']))
    const picked: ExportOptions = { ...hevc.options, userPreset: hevc.id }
    expect(presets.matchesUserPreset(picked, hevc, noHevc)).toBe(true)
    expect(presets.matchesUserPreset(rows.usableCodec(picked, caps('none')).options, hevc, noHevc)).toBe(true)
    expect(presets.matchesUserPreset(picked, hevc, withHevc)).toBe(true)
    // Where HEVC can be made, H.264 is a change.
    expect(presets.matchesUserPreset(o('mp4', { fps: 60 }), hevc, withHevc)).toBe(false)
    // Any other change deselects it; the encoder is the preset's own.
    expect(presets.matchesUserPreset({ ...picked, fps: 30 }, hevc, noHevc)).toBe(false)
    expect(presets.matchesUserPreset({ ...picked, encoder: 'software' }, user('A', o('mp4')), noHevc)).toBe(false)
    expect(presets.matchesUserPreset(o('mov', { codec: 'cineform', alpha: 'overlays' }), user('A', o('mov', { codec: 'cineform' })), noHevc)).toBe(false)
    // The batch row: the same notice before the export starts.
    const [item] = presets.batchItems([], [], o('mp4'), [hevc])
    expect(rows.usableCodec(item.options, caps('none')).notice).toBe('codecs.notice.cannotMake')
    expect(rows.usableCodec({ ...item.options, userPreset: hevc.id }, caps('none')).notice).toBe('presets.notice.cannotMake')
  })
})
