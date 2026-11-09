import { describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import type { ExportCodec, ExportFormat } from '../src/shared/types'

/*
 * The contracts of output and the app (docs/design/output-and-languages.md §21.0): the frozen tables
 * and readers (tests 5 and 6, and the rules of §4.3, §4.6, §18.3 and §18.5), and the seams every
 * part plugs into. Each rule here fails without its code.
 */

const formats = await import('../src/shared/render/proFormats')
const presets = await import('../src/shared/render/exportPresets')
const { normalizeBundle, sidecarBlocked, NO_BUNDLE } = await import('../src/shared/render/exportBundle')
const userPresets = await import('../src/shared/render/userPresets')
const { checkTimelinePlan, PLAN_LIMITS } = await import('../src/shared/interchange/planCheck')
const { readUiPrefs } = await import('../src/shared/i18n/locale')
const { validateJob } = await import('../src/main/exportJob')
const { exportProject, exportRoutes, isAudioOnly, routeLabel, videoCodecOf } = await import('../src/shared/render/exportPlan')
const { outputSize } = await import('../src/shared/engine/layout')
const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { ASPECT_RATIOS } = await import('../src/shared/editor/styleDefaults')
const { ivfFileHeader } = await import('../src/shared/render/codec')

const { CODEC_POLICY, FORMAT_CODECS, nearestCodec, canAlpha, codecOf, isIntermediate, ALLOWED_ENCODERS, EXPORT_FPS, DEFAULT_CODEC } = formats

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

describe('codecs per format and the owner’s policy (§0, §5.1-5.2)', () => {
  it('lists each format’s codecs with its old codec first, and none for GIF and the audio formats', () => {
    expect(FORMAT_CODECS.mp4).toEqual(['h264', 'hevc', 'av1'])
    expect(FORMAT_CODECS.mov).toEqual(['h264', 'hevc', 'cineform', 'animation', 'prores-422', 'prores-4444'])
    expect(FORMAT_CODECS.webm).toEqual(['vp9', 'av1'])
    for (const f of ['gif', 'm4a', 'wav'] as const) expect(FORMAT_CODECS[f]).toEqual([])
    expect(DEFAULT_CODEC).toEqual({ mp4: 'h264', mov: 'h264', webm: 'vp9' })
    expect(codecOf({ format: 'webm' })).toBe('vp9')
    expect(codecOf({ format: 'mov', codec: 'cineform' })).toBe('cineform')
  })

  it('ships the owner’s decisions: HEVC on the graphics card only, no ProRes, CineForm', () => {
    expect(CODEC_POLICY).toEqual({ hevcSoftware: false, prores: false, cineform: true })
    expect(ALLOWED_ENCODERS).not.toContain('libx265')
    expect(ALLOWED_ENCODERS).not.toContain('prores_ks')
    expect(ALLOWED_ENCODERS).not.toContain('dnxhd')
  })

  it('names every encoder of before and of this wave, and nothing else', () => {
    const today = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libvpx-vp9', 'copy', 'ffv1', 'aac', 'libopus', 'flac', 'libmp3lame', 'pcm_s16le']
    const wave12 = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'av1_nvenc', 'av1_qsv', 'av1_amf', 'libaom-av1', 'cfhd', 'qtrle', 'pcm_f32le', 'pcm_s24le']
    expect([...ALLOWED_ENCODERS].sort()).toEqual([...today, ...wave12].sort())
  })

  it('finds the nearest codec a format can make: ProRes to CineForm to Lossless to the default', () => {
    expect(nearestCodec('prores-422', 'mov')).toBe('cineform')
    expect(nearestCodec('prores-4444', 'mov')).toBe('cineform')
    expect(withPolicy({ cineform: false }, () => nearestCodec('prores-4444', 'mov'))).toBe('animation')
    expect(withPolicy({ cineform: false }, () => nearestCodec('cineform', 'mov'))).toBe('animation')
    expect(withPolicy({ prores: true }, () => nearestCodec('prores-422', 'mov'))).toBe('prores-422')
    expect(nearestCodec('hevc', 'mp4')).toBe('hevc')
    expect(nearestCodec('cineform', 'mp4')).toBe('h264')
    expect(nearestCodec('av1', 'mov')).toBe('h264')
    expect(nearestCodec('h264', 'webm')).toBe('vp9')
  })

  it('carries transparency in VP9, CineForm, Lossless and ProRes 4444 only, as the policy allows', () => {
    expect(canAlpha('webm', 'vp9')).toBe(true)
    expect(canAlpha('mov', 'cineform')).toBe(true)
    expect(canAlpha('mov', 'animation')).toBe(true)
    expect(canAlpha('mov', 'prores-4444')).toBe(false)
    expect(withPolicy({ prores: true }, () => canAlpha('mov', 'prores-4444'))).toBe(true)
    expect(withPolicy({ cineform: false }, () => canAlpha('mov', 'cineform'))).toBe(false)
    for (const c of ['h264', 'hevc', 'av1'] as ExportCodec[]) for (const f of ['mp4', 'mov', 'webm'] as ExportFormat[]) expect(canAlpha(f, c)).toBe(false)
    expect(canAlpha('mp4', 'vp9')).toBe(false)
    expect(['cineform', 'animation', 'prores-422', 'prores-4444'].every((c) => isIntermediate(c as ExportCodec))).toBe(true)
    expect(['h264', 'hevc', 'av1', 'vp9'].some((c) => isIntermediate(c as ExportCodec))).toBe(false)
    expect(EXPORT_FPS).toEqual([24, 25, 30, 60, 120])
  })
})

describe('stored export settings (§4.3)', () => {
  const base = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }

  it('keeps a codec the format carries and is not its default, after the five old keys', () => {
    const o = presets.normalizeOptions({ ...base, format: 'mov', codec: 'cineform' })
    expect(JSON.stringify(o)).toBe('{"format":"mov","resolution":1080,"fps":60,"quality":"high","encoder":"auto","codec":"cineform"}')
    expect(presets.normalizeOptions({ ...base, codec: 'h264' })).not.toHaveProperty('codec')
    expect(presets.normalizeOptions({ ...base, format: 'webm', codec: 'vp9' })).not.toHaveProperty('codec')
    expect(presets.normalizeOptions({ ...base, codec: 'cineform' })).not.toHaveProperty('codec')
    expect(presets.normalizeOptions({ ...base, codec: 'xvid' })).not.toHaveProperty('codec')
    expect(presets.normalizeOptions({ ...base, format: 'gif', codec: 'hevc' })).not.toHaveProperty('codec')
  })

  it('turns a codec the policy forbids into its nearest allowed one, keeping alpha it carries, and reports it', () => {
    const changes: [ExportCodec, ExportCodec][] = []
    const o = presets.normalizeOptions({ ...base, format: 'mov', codec: 'prores-4444', alpha: 'overlays' }, (from, to) => changes.push([from, to]))
    expect(o.codec).toBe('cineform')
    expect(o.alpha).toBe('overlays')
    expect(presets.normalizeOptions({ ...base, format: 'mov', codec: 'prores-422' }).codec).toBe('cineform')
    expect(changes).toEqual([['prores-4444', 'cineform']])
  })

  it('keeps alpha only where the format and codec carry it', () => {
    expect(presets.normalizeOptions({ ...base, alpha: 'background' })).not.toHaveProperty('alpha')
    expect(presets.normalizeOptions({ ...base, format: 'mov', alpha: 'background' })).not.toHaveProperty('alpha')
    expect(presets.normalizeOptions({ ...base, format: 'webm', alpha: 'background' }).alpha).toBe('background')
    expect(presets.normalizeOptions({ ...base, format: 'webm', codec: 'av1', alpha: 'background' })).not.toHaveProperty('alpha')
    expect(presets.normalizeOptions({ ...base, format: 'webm', alpha: 'see-through' })).not.toHaveProperty('alpha')
  })

  it('accepts the new rates, 4:5, WAV and a user preset id; drops everything else', () => {
    for (const fps of [24, 25, 30, 60, 120]) expect(presets.normalizeOptions({ ...base, fps }).fps).toBe(fps)
    for (const fps of [23.976, 29.97, 121, 50, '24']) expect(presets.normalizeOptions({ ...base, fps }).fps).toBe(60)
    expect(presets.normalizeOptions({ ...base, aspect: '4:5' }).aspect).toBe('4:5')
    expect(presets.normalizeOptions({ ...base, format: 'wav' }).format).toBe('wav')
    expect(presets.normalizeOptions({ ...base, userPreset: 'user:0123456789ab' }).userPreset).toBe('user:0123456789ab')
    for (const id of ['user:0123456789AB', 'user:0123', 'youtube-1080', 'user:0123456789abc']) expect(presets.normalizeOptions({ ...base, userPreset: id })).not.toHaveProperty('userPreset')
  })

  it('compares codec and alpha with a destination: absent equals absent, so a codec or transparency makes it Custom', () => {
    const yt = presets.presetById('youtube-1080')!
    const o = presets.applyPreset({ encoder: 'auto' }, yt)
    expect(presets.matchesPreset(o, yt)).toBe(true)
    expect(presets.matchesPreset({ ...o, codec: 'hevc' }, yt)).toBe(false)
    expect(presets.tweakOptions(o, { codec: 'hevc' }).preset).toBeUndefined()
    const mov = { ...o, format: 'mov' as const }
    expect(presets.matchesPreset({ ...mov, alpha: 'background' }, { ...yt, format: 'mov' })).toBe(false)
    const editing = { ...yt, id: 'x-editing', format: 'mov' as const, codec: 'cineform' as const, alpha: 'overlays' as const }
    const applied = presets.applyPreset({ encoder: 'auto' }, editing)
    expect(applied).toMatchObject({ codec: 'cineform', alpha: 'overlays' })
    expect(presets.matchesPreset(applied, editing)).toBe(true)
    expect(presets.matchesPreset({ ...applied, codec: undefined }, editing)).toBe(false)
  })

  it('reads batch choices: an old value back as stored, 4:5 and user presets when present', () => {
    expect(JSON.stringify(presets.readBatchChoice({ presets: ['x', 'nope'], aspects: ['9:16', '2:1'] }))).toBe('{"presets":["x"],"aspects":["9:16"]}')
    expect(presets.readBatchChoice({ presets: [], aspects: ['4:5'] }).aspects).toEqual(['4:5'])
    expect(presets.readBatchChoice({ presets: [], aspects: [], userPresets: ['user:0123456789ab', 'user:0123456789ab', 'user:nope', 7] }).userPresets).toEqual(['user:0123456789ab'])
    expect(presets.readBatchChoice({ presets: [], aspects: [], userPresets: [] })).not.toHaveProperty('userPresets')
    expect(presets.readBatchChoice(null)).toEqual({ presets: [], aspects: [] })
  })

  it('reads the new Also save choices only when present and valid; an old value gains no key', () => {
    const old = { srt: true, vtt: false, chapters: true, thumbnail: false, description: false, perChapter: false }
    expect(JSON.stringify(normalizeBundle(old))).toBe(JSON.stringify(old))
    expect(Object.keys(NO_BUNDLE)).toEqual(['srt', 'vtt', 'chapters', 'thumbnail', 'description', 'perChapter'])
    const b = normalizeBundle({ ...old, stems: true, timelines: ['premiere', 'resolve', 'premiere', 'imovie'], timelineMedia: 'recordings' })
    expect(b.stems).toBe(true)
    expect(b.timelines).toEqual(['resolve', 'premiere'])
    expect(b.timelineMedia).toBe('recordings')
    const bad = normalizeBundle({ ...old, stems: 'yes', timelines: [], timelineMedia: 'export' })
    expect(Object.keys(bad)).toEqual(Object.keys(old))
  })

  it('names WAV, and gives it no thumbnail', () => {
    expect(presets.FORMAT_EXTENSIONS.wav).toBe('wav')
    expect(presets.FORMAT_LABELS.wav).toBe('WAV')
    expect(sidecarBlocked('thumbnail', 'wav', { captions: true, chapters: true })).toBe('Audio files have no thumbnail')
    expect(isAudioOnly('wav')).toBe(true)
    expect(videoCodecOf('wav')).toBeNull()
    expect(routeLabel({ video: 'none' }, 'wav')).toBe('Audio only (WAV)')
    expect(routeLabel({ video: 'none' }, 'm4a')).toBe('Audio only (AAC)')
    expect(exportRoutes({ format: 'wav', encoder: 'auto' }, { hardwareEncoders: [], overrides: {} })).toEqual([{ video: 'none' }])
  })
})

describe('4:5 and projects (§4.1, §4.6, §5.8)', () => {
  it('sizes 4:5 exports at every resolution', () => {
    expect([720, 1080, 1440, 2160].map((h) => outputSize('4:5', 1920, 1080, h))).toEqual([
      { width: 720, height: 900 },
      { width: 1080, height: 1350 },
      { width: 1440, height: 1800 },
      { width: 2160, height: 2700 }
    ])
  })

  it('turns the app safe zones off in a 4:5 copy only, never in the project or a 9:16 copy', () => {
    const project = { style: { aspectRatio: '16:9' as const }, reframe: { mode: 'follow' as const, appSafe: true } }
    const copy = exportProject(project as never, { aspect: '4:5' }) as typeof project
    expect(copy.style.aspectRatio).toBe('4:5')
    expect(copy.reframe.appSafe).toBe(false)
    expect(project.reframe.appSafe).toBe(true)
    const tall = exportProject(project as never, { aspect: '9:16' }) as typeof project
    expect(tall.reframe.appSafe).toBe(true)
    expect(exportProject(project as never, {})).toBe(project)
  })

  it('reads a project shape outside the list as auto, in place; every listed shape as it is', () => {
    const p = createProject({ id: 'p1', name: 'P', duration: 5, width: 1920, height: 1080, hasWebcam: false } as never)
    const odd = migrateProject(JSON.parse(JSON.stringify({ ...p, style: { ...p.style, aspectRatio: '4:5' } })))
    expect(odd.style.aspectRatio).toBe('auto')
    expect(Object.keys(odd)).toEqual(Object.keys(migrateProject(JSON.parse(JSON.stringify(p)))))
    for (const a of ASPECT_RATIOS) {
      const raw = JSON.parse(JSON.stringify({ ...p, style: { ...p.style, aspectRatio: a } }))
      expect(JSON.stringify(migrateProject(raw).style)).toBe(JSON.stringify(raw.style))
    }
    // The migration's own list is the projects' list.
    expect(ASPECT_RATIOS).toEqual(['auto', '16:9', '9:16', '1:1', '4:3'])
  })
})

describe('the preset readers on hostile input (test 5)', () => {
  const options = { format: 'mov', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', codec: 'cineform' }
  const file = (list: unknown[]): string => JSON.stringify({ flown: 'export-presets', version: 1, presets: list })

  it('cleans names: NFC, controls, bidi controls, private use and separators dropped, ZWJ and ZWNJ kept, 60 graphemes', () => {
    expect(userPresets.cleanPresetName('  Client‮ review\u0000 \\ / ')).toBe('Client review')
    expect(userPresets.cleanPresetName('র‍্যা and ‌x')).toBe('র‍্যা and ‌x')
    expect(userPresets.cleanPresetName('য়')).toBe(userPresets.cleanPresetName('য়'))
    expect(userPresets.cleanPresetName('ab\u{F0001}c')).toBe('abc')
    expect(userPresets.cleanPresetName('x'.repeat(61))).toBe('x'.repeat(60))
    expect(userPresets.cleanPresetName('বাং'.repeat(40))!.length).toBeLessThanOrEqual(4096)
    expect(userPresets.cleanPresetName('x'.repeat(10_000_000))).toBe('x'.repeat(60))
    for (const bad of ['', '   ', '‮\u0000', 7, null, { name: 'x' }]) expect(userPresets.cleanPresetName(bad)).toBeNull()
  })

  it('refuses files that are not preset files, too large, or not JSON, without throwing', () => {
    expect(userPresets.readPresetFile('x'.repeat(65 * 1024))).toBeNull()
    expect(userPresets.readPresetFile(`${file([{ name: 'A', options }])}${' '.repeat(65 * 1024)}`)).toBeNull()
    expect(userPresets.readPresetFile('{nope')).toBeNull()
    expect(userPresets.readPresetFile(JSON.stringify({ flown: 'export-presets', version: 2, presets: [] }))).toBeNull()
    expect(userPresets.readPresetFile(JSON.stringify({ flown: 'project', version: 1, presets: [] }))).toBeNull()
    const deep = `${'['.repeat(1000)}${']'.repeat(1000)}`
    expect(() => userPresets.readPresetFile(`{"flown":"export-presets","version":1,"presets":${deep}}`)).not.toThrow()
  })

  it('keeps at most 50 presets and counts the rest, drops unknown fields, and counts codec changes', () => {
    const list = Array.from({ length: 200 }, (_, i) => ({ name: `P ${i}`, options: { ...options, codec: i < 2 ? 'prores-422' : 'cineform' }, extra: 'x', id: 'user:aaaaaaaaaaaa' }))
    const read = userPresets.readPresetFile(file(list))!
    expect(read.presets).toHaveLength(50)
    expect(read.skipped).toBe(150)
    expect(read.changed).toEqual([{ from: 'prores-422', to: 'cineform', count: 2 }])
    expect(Object.keys(read.presets[0])).toEqual(['id', 'name', 'options', 'saved'])
    expect(read.presets[0].options).toEqual({ format: 'mov', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', codec: 'cineform' })
  })

  it('reads __proto__, constructor and wrong types as data and never pollutes anything', () => {
    const text = `{"flown":"export-presets","version":1,"presets":[{"name":"A","options":{"format":"mp4","resolution":1080,"fps":30,"quality":"high","encoder":"auto","__proto__":{"polluted":1},"constructor":{"x":1}},"bundle":{"__proto__":{"stems":true},"srt":true}},{"name":5,"options":{}},{"name":"B","options":"mp4"},"x",null]}`
    const read = userPresets.readPresetFile(text)!
    expect(read.presets.map((p) => p.name)).toEqual(['A'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(read.presets[0].options).not.toHaveProperty('constructor', { x: 1 })
    expect(read.presets[0].bundle).toEqual({ srt: true, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false })
  })

  it('round-trips presetFileText through readPresetFile, without ids, save times or subtitle languages', () => {
    const saved: import('../src/shared/render/userPresets').UserExportPreset[] = [
      { id: 'user:0123456789ab', name: 'Client review', options: presets.normalizeOptions(options), saved: 1, bundle: { ...NO_BUNDLE, stems: true } },
      { id: 'user:ba9876543210', name: 'বাংলা', options: presets.normalizeOptions({ ...options, format: 'webm', codec: 'av1' }), saved: 2 }
    ]
    const text = userPresets.presetFileText(saved)
    expect(text).not.toContain('user:')
    expect(text).not.toContain('"saved"')
    const read = userPresets.readPresetFile(text)!
    expect(read.presets.map((p) => ({ name: p.name, options: p.options, bundle: p.bundle }))).toEqual(saved.map((p) => ({ name: p.name, options: p.options, bundle: p.bundle })))
    expect(read.skipped).toBe(0)
    expect(read.changed).toEqual([])
  })

  it('reads the preference store the same way: valid ids once, at most 50, names cleaned, malformed as absent', () => {
    expect(userPresets.readUserPresets({ version: 2, presets: [] })).toBeNull()
    expect(userPresets.readUserPresets('x')).toBeNull()
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `user:${i.toString(16).padStart(12, '0')}`, name: `P‮${i}`, options, saved: i }))
    const store = userPresets.readUserPresets({ version: 1, presets: [...many, { id: 'youtube-1080', name: 'X', options, saved: 0 }] })!
    expect(store.presets).toHaveLength(50)
    expect(store.presets[0]).toEqual({ id: 'user:000000000000', name: 'P0', options: presets.normalizeOptions(options), saved: 0 })
    const dup = userPresets.readUserPresets({ version: 1, presets: [many[1], many[1], { ...many[2], saved: -4 }, { ...many[3], options: { ...options, preset: 'youtube-1080', userPreset: 'user:000000000003' } }] })!
    expect(dup.presets.map((p) => p.id)).toEqual(['user:000000000001', 'user:000000000002', 'user:000000000003'])
    expect(dup.presets[1].saved).toBe(0)
    expect(dup.presets[2].options).not.toHaveProperty('userPreset')
    expect(dup.presets[2].options).not.toHaveProperty('preset')
  })

  it('makes ids of 12 hex digits that never equal a built-in id', () => {
    let k = 0
    const random = (): number => [0, 0.99999, 0.5, 0.0625][k++ % 4]
    const id = userPresets.newPresetId(random)
    expect(id).toMatch(/^user:[0-9a-f]{12}$/)
    expect(id).toBe('user:0f810f810f81')
    expect(presets.EXPORT_PRESETS.some((p) => p.id === id || p.id.includes(':'))).toBe(false)
    expect(userPresets.newPresetId(() => NaN)).toBe('user:000000000000')
    expect(userPresets.newPresetId(() => 1)).toBe('user:ffffffffffff')
  })

  it('reads the language preference: only known values, lists of at most 8 languages', () => {
    expect(readUiPrefs(null)).toBeNull()
    expect(readUiPrefs([])).toBeNull()
    expect(readUiPrefs({})).toEqual({})
    expect(readUiPrefs({ language: 'bn', digits: 'western', offered: ['bn', 'bn'], seen: ['hi', 'es'] })).toEqual({ language: 'bn', digits: 'western', offered: ['bn'], seen: ['hi', 'es'] })
    expect(readUiPrefs({ language: 'system' })).toEqual({ language: 'system' })
    expect(readUiPrefs({ language: 'fr', digits: 'beng', offered: ['bn', 'fr'], seen: Array(9).fill('bn'), __proto__: { language: 'bn' } })).toEqual({})
    expect(readUiPrefs({ language: 'bn', seen: Array(8).fill('en') })).toEqual({ language: 'bn', seen: ['en'] })
  })
})

describe('validateJob (test 6)', () => {
  const video = (over: Partial<ExportJob>): ExportJob =>
    ({
      width: 1920,
      height: 1080,
      fps: 30,
      frames: 60,
      format: 'mp4',
      quality: 'high',
      video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' },
      audio: { clips: [{ start: 0, end: 2, speed: 1 }], volume: 1 },
      outputPath: '/out/a.mp4',
      ...over
    }) as ExportJob
  const refused = (job: ExportJob): void => expect(() => validateJob(job), JSON.stringify(job)).toThrow()
  const accepted = (job: ExportJob): void => expect(() => validateJob(job), JSON.stringify(job)).not.toThrow()

  it('refuses a codec outside its format or forbidden by the policy', () => {
    refused(video({ codec: 'cineform', video: { kind: 'raw', encoder: 'cfhd', pixelFormat: 'bgr0' } }))
    refused(video({ format: 'webm', codec: 'hevc', video: { kind: 'raw', encoder: 'hevc_nvenc', pixelFormat: 'yuv420p' } }))
    refused(video({ format: 'mov', codec: 'prores-4444', video: { kind: 'raw', encoder: 'prores_ks', pixelFormat: 'bgra' } }))
    refused(video({ format: 'mov', codec: 'xvid' as ExportCodec }))
    withPolicy({ prores: true }, () => accepted(video({ format: 'mov', codec: 'prores-4444', video: { kind: 'raw', encoder: 'prores_ks', pixelFormat: 'bgra' } })))
    accepted(video({ format: 'mov', codec: 'cineform', video: { kind: 'raw', encoder: 'cfhd', pixelFormat: 'bgr0' } }))
    accepted(video({ format: 'webm', codec: 'av1', video: { kind: 'raw', encoder: 'libaom-av1', pixelFormat: 'yuv420p' } }))
  })

  it('takes encoders and streams of the job’s own codec only; libx265 never while the policy is off', () => {
    refused(video({ codec: 'hevc', video: { kind: 'raw', encoder: 'libx265', pixelFormat: 'yuv420p' } }))
    withPolicy({ hevcSoftware: true }, () => accepted(video({ codec: 'hevc', video: { kind: 'raw', encoder: 'libx265', pixelFormat: 'yuv420p' } })))
    refused(video({ codec: 'hevc', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' } }))
    refused(video({ video: { kind: 'raw', encoder: 'hevc_nvenc', pixelFormat: 'yuv420p' } }))
    const color = { primaries: 1, transfer: 1, matrix: 6, fullRange: false }
    accepted(video({ codec: 'hevc', video: { kind: 'hevc', color } }))
    refused(video({ codec: 'av1', video: { kind: 'hevc', color } }))
    refused(video({ video: { kind: 'hevc', color } }))
    accepted(video({ format: 'webm', codec: 'av1', video: { kind: 'av1', color } }))
    refused(video({ format: 'mov', codec: 'av1', video: { kind: 'av1', color } }))
  })

  it('refuses alpha with H.264, with I420 frames, or without a raw input', () => {
    refused(video({ alpha: true, video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'bgra' } }))
    refused(video({ format: 'webm', alpha: true, video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'yuv420p' } }))
    refused(video({ format: 'webm', alpha: true, video: { kind: 'vp9', color: { primaries: 1, transfer: 1, matrix: 6, fullRange: false } } }))
    refused(video({ format: 'webm', alpha: 'yes' as unknown as true, video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'bgra' } }))
    accepted(video({ format: 'webm', alpha: true, video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'bgra' } }))
    accepted(video({ format: 'mov', codec: 'animation', alpha: true, video: { kind: 'raw', encoder: 'qtrle', pixelFormat: 'rgba' } }))
  })

  it('refuses stems on a GIF, on a silent job, and malformed ones', () => {
    const gif = video({ format: 'gif', fps: 15, audio: undefined, video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'bgra' } })
    accepted(gif)
    refused({ ...gif, stems: { stems: ['recording'] } })
    refused(video({ audio: undefined, stems: { stems: ['recording'] } }))
    accepted(video({ stems: { stems: ['voice', 'system', 'music'], gainDb: -3.5, gains: { mic: 1, system: 0.5 } } }))
    refused(video({ stems: { stems: [] } }))
    refused(video({ stems: { stems: ['music', 'voice'] } }))
    refused(video({ stems: { stems: ['voice', 'voice'] } }))
    refused(video({ stems: { stems: ['recording', 'voice'] } }))
    refused(video({ stems: { stems: ['voice'], gainDb: 31 } }))
    refused(video({ stems: { stems: ['voice'], gains: { camera: 1 } as never } }))
    refused(video({ stems: { stems: ['drums' as never] } }))
  })

  it('takes 24, 25 and 120 fps and refuses 23.976 and 121', () => {
    for (const fps of [24, 25, 30, 60, 120]) accepted(video({ fps }))
    for (const fps of [23.976, 121, 0]) refused(video({ fps }))
  })

  it('takes WAV as audio only, like M4A', () => {
    const wav = video({ format: 'wav', width: 0, height: 0, fps: 60, video: { kind: 'none' }, outputPath: '/out/a.wav' })
    accepted(wav)
    refused({ ...wav, video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' } })
    expect(() => validateJob({ ...wav, audio: undefined })).toThrow('This recording has no sound to export.')
    accepted({ ...wav, stems: { stems: ['recording'] } })
  })
})

describe('the timeline plan check (§18.3)', () => {
  const plan = () => ({
    name: 'Demo',
    fps: 30,
    width: 1920,
    height: 1080,
    frames: 300,
    pictureOnly: true,
    tracks: [
      { kind: 'video', name: 'V1', enabled: true, events: [{ media: 'video', recIn: 0, recOut: 300, srcIn: 0, srcOut: 300, speed: 1 }] },
      { kind: 'audio', name: 'Voice', role: 'dialogue', enabled: true, events: [{ media: 'voice', recIn: 0, recOut: 150, srcIn: 0, srcOut: 150, speed: 1 }, { media: 'voice', recIn: 150, recOut: 300, srcIn: 150, srcOut: 150, speed: 0, dissolve: 4 }] }
    ],
    markers: [{ frame: 0, name: 'Intro', chapter: true }],
    media: { video: { fps: 30, frames: 300, width: 1920, height: 1080, audio: false, video: true }, voice: { fps: 30, frames: 300, audio: true, video: false } }
  })
  const broken = (edit: (p: ReturnType<typeof plan>) => void): string | null => {
    const p = plan()
    edit(p)
    return checkTimelinePlan(p)
  }

  it('accepts a well-formed plan', () => {
    expect(checkTimelinePlan(plan())).toBeNull()
  })

  it('refuses each broken rule', () => {
    expect(checkTimelinePlan(null)).not.toBeNull()
    expect(broken((p) => (p.fps = 29.97))).not.toBeNull()
    expect(broken((p) => (p.fps = 120))).not.toBeNull()
    expect(broken((p) => (p.width = 5000))).not.toBeNull()
    expect(broken((p) => (p.name = 'x'.repeat(501)))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].recIn = 0.5))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].recIn = -1))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].recOut = 0))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].srcOut = -1))).not.toBeNull()
    expect(broken((p) => (p.tracks[1].events[1].recIn = 100))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].recOut = 301))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].media = 'camera'))).not.toBeNull()
    expect(broken((p) => (p.tracks[0].events[0].speed = Number.NaN))).not.toBeNull()
    expect(broken((p) => (p.markers[0].name = 'x'.repeat(501)))).not.toBeNull()
    expect(broken((p) => (p.markers = Array.from({ length: PLAN_LIMITS.markers + 1 }, () => ({ frame: 0, name: 'm', chapter: false }))))).not.toBeNull()
    expect(broken((p) => (p.tracks[1].events = Array.from({ length: PLAN_LIMITS.events + 1 }, (_, i) => ({ media: 'voice', recIn: i, recOut: i + 1, srcIn: 0, srcOut: 1, speed: 1 }))))).not.toBeNull()
    expect(broken((p) => (p.media = { ...p.media, ['__proto__']: { fps: 1 } } as never))).not.toBeNull()
    expect(broken((p) => ((p.tracks[0] as Record<string, unknown>).enabled = 'yes'))).not.toBeNull()
  })
})

describe('seams (§21.0)', () => {
  it('writes the IVF fourcc of AV1 and keeps VP9’s header byte for byte by default', () => {
    const vp9 = ivfFileHeader(1920, 1080, 60)
    expect([...vp9.subarray(8, 12)]).toEqual([0x56, 0x50, 0x39, 0x30])
    expect(ivfFileHeader(1920, 1080, 60, 0, 'VP90')).toEqual(vp9)
    const av1 = ivfFileHeader(1920, 1080, 60, 0, 'AV01')
    expect(String.fromCharCode(...av1.subarray(8, 12))).toBe('AV01')
    expect([...av1.subarray(12)]).toEqual([...vp9.subarray(12)])
  })
})

describe('routes and plans of the new codecs go to the parts’ builders', () => {
  it('sends a non-default codec or a transparent background to codecRoutes, with what this PC can make and the size', async () => {
    vi.resetModules()
    const codecRoutes = vi.fn(() => [{ video: 'ffmpeg', encoder: 'cfhd' }])
    vi.doMock('../src/shared/render/codecRoutes', () => ({ codecRoutes }))
    const plan = await import('../src/shared/render/exportPlan')
    const caps = { hardwareEncoders: [], overrides: {} }
    const codecCaps = { webcodecs: { hevc: true, av1: false }, gpu: { hevc: [], av1: [] }, overrides: {} }
    expect(plan.exportRoutes({ format: 'mov', encoder: 'auto', codec: 'cineform', resolution: 1080 }, caps, codecCaps, { width: 1920, height: 1080 })).toEqual([{ video: 'ffmpeg', encoder: 'cfhd' }])
    expect(codecRoutes).toHaveBeenCalledWith(expect.objectContaining({ codec: 'cineform' }), codecCaps, { width: 1920, height: 1080 })
    plan.exportRoutes({ format: 'webm', encoder: 'auto', alpha: 'background' }, caps)
    expect(codecRoutes).toHaveBeenCalledTimes(2)
    // The codecs of before route as they did, without asking.
    plan.exportRoutes({ format: 'mp4', encoder: 'auto' }, caps)
    plan.exportRoutes({ format: 'webm', encoder: 'auto', codec: 'vp9' }, caps)
    expect(codecRoutes).toHaveBeenCalledTimes(2)
    vi.doUnmock('../src/shared/render/codecRoutes')
  })

  it('plans WAV with wavPlan and a non-default codec or alpha with proPlan; the jobs of before as they did', async () => {
    vi.resetModules()
    const wavPlan = vi.fn(() => ({ capture: ['wav'], passes: [], scripts: [], temps: [] }))
    const proPlan = vi.fn(() => ({ capture: ['pro'], passes: [], scripts: [], temps: [] }))
    vi.doMock('../src/main/stemsArgs', () => ({ wavPlan }))
    vi.doMock('../src/main/proArgs', () => ({ proPlan }))
    const { ffmpegPlan } = await import('../src/main/exportArgs')
    const given = { audioInput: '/p/screen.mp4', output: '/o/x.tmp', tempStem: '/t/s' }
    const base = { width: 1920, height: 1080, fps: 30, frames: 30, quality: 'high', outputPath: '/o/x' } as const
    expect(ffmpegPlan({ ...base, format: 'wav', video: { kind: 'none' } } as ExportJob, given).capture).toEqual(['wav'])
    expect(ffmpegPlan({ ...base, format: 'mov', codec: 'cineform', video: { kind: 'raw', encoder: 'cfhd', pixelFormat: 'bgr0' } } as ExportJob, given).capture).toEqual(['pro'])
    expect(ffmpegPlan({ ...base, format: 'webm', alpha: true, video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'bgra' } } as ExportJob, given).capture).toEqual(['pro'])
    const plain = ffmpegPlan({ ...base, format: 'mp4', codec: 'h264', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' } } as ExportJob, given)
    expect(plain.capture).toContain('libx264')
    expect(wavPlan).toHaveBeenCalledTimes(1)
    expect(proPlan).toHaveBeenCalledTimes(2)
    vi.doUnmock('../src/main/stemsArgs')
    vi.doUnmock('../src/main/proArgs')
  })
})
