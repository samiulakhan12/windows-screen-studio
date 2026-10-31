import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import type { CaptionSegment, Project } from '../src/shared/types'

/*
 * Subtitle tracks and files in the export (docs/design/captions-studio.md §11.10, test 28): the
 * streams' arguments (mov_text in MP4 and MOV, webvtt in WebM, ISO 639-2 codes, the default
 * disposition, both passes), streams only with Also inside the video, one file per ticked
 * language with its name, none for GIF and M4A, and the main process's checks. Spoken subtitles
 * go through the bleep masks (test 50).
 */

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, app: { getPath: () => tmpdir(), on: vi.fn(), isPackaged: false }, dialog: {}, shell: {} }))
const masked = vi.fn((segments: readonly CaptionSegment[], _bleeps?: unknown) => segments)
vi.mock('../src/shared/captions/cleanup', async (original) => ({ ...(await original()), maskedSegments: (s: readonly CaptionSegment[], b: unknown) => masked(s, b as never) }))
vi.mock('../src/shared/captions/trackCues', () => ({
  trackCues: (_p: Project, language: string) => [{ start: 0.5, end: 3, text: language === 'bn' ? 'আমরা আজ শিখব' : 'hola' }],
  trackVtt: () => 'WEBVTT\n'
}))

const { ffmpegPlan, iso6392, subtitleArgs } = await import('../src/main/exportArgs')
const { tempStem, validateJob } = await import('../src/main/exportJob')
const { isExportTempFile } = await import('../src/main/exportCleanup')
const { sidecarTarget } = await import('../src/main/exportBundle')
const { normalizeBundle, sidecarName, subtitleLanguages, subtitleStreams } = await import('../src/shared/render/exportBundle')
const { languageSubtitleFile, spokenSegments } = await import('../src/shared/captions/subtitles')

const VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:03.000\nHello\n'
const tracks = [
  { file: '/tmp/s.sub0.vtt', iso: 'eng', name: 'English', default: true },
  { file: '/tmp/s.sub1.vtt', iso: 'ben', name: 'Bangla', default: false }
]

const job: ExportJob = {
  width: 1280,
  height: 720,
  fps: 30,
  frames: 300,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
  outputPath: '/videos/out.mp4',
  subtitles: [
    { language: 'en', name: 'English', vtt: VTT, default: true },
    { language: 'bn', name: 'Bangla', vtt: VTT, default: false }
  ]
}

const after = (args: string[], flag: string, from = 0): string => args[args.indexOf(flag, from) + 1]

describe('subtitleArgs (§11.10)', () => {
  it('adds each WebVTT file as an input and maps it as mov_text in MP4 and MOV', () => {
    for (const format of ['mp4', 'mov'] as const) {
      const inputs: string[] = ['-i', 'pipe:0']
      const out = subtitleArgs({ inputs }, 1, tracks, format)
      expect(inputs).toEqual(['-i', 'pipe:0', '-f', 'webvtt', '-i', '/tmp/s.sub0.vtt', '-f', 'webvtt', '-i', '/tmp/s.sub1.vtt'])
      expect(out).toEqual([
        '-map', '1:s', '-map', '2:s', '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'handler_name=English', '-disposition:s:0', 'default',
        '-metadata:s:s:1', 'language=ben', '-metadata:s:s:1', 'handler_name=Bangla', '-disposition:s:1', '0'
      ])
    }
  })

  it('encodes webvtt with titles in WebM', () => {
    const out = subtitleArgs({ inputs: [] }, 3, tracks, 'webm')
    expect(after(out, '-c:s')).toBe('webvtt')
    expect(out).toContain('title=Bangla')
    expect(out).not.toContain('handler_name=Bangla')
    expect(after(out, '-map')).toBe('3:s')
  })

  it('adds nothing for GIF and M4A, or without tracks', () => {
    for (const format of ['gif', 'm4a'] as const) {
      const inputs: string[] = []
      expect(subtitleArgs({ inputs }, 0, tracks, format)).toEqual([])
      expect(inputs).toEqual([])
    }
    expect(subtitleArgs({ inputs: [] }, 0, [], 'mp4')).toEqual([])
  })

  it('maps languages to ISO 639-2 (the MP4 muxer drops two-letter codes), und outside the map', () => {
    expect(['en', 'bn', 'pt-BR', 'zh-Hant', 'sv', 'xx'].map(iso6392)).toEqual(['eng', 'ben', 'por', 'zho', 'swe', 'und'])
  })
})

describe('the export plan with subtitle streams', () => {
  it('writes each language as a WebVTT file after the chapters and maps it in the single pass', () => {
    const plan = ffmpegPlan(job, { audioInput: null, output: '/o.mp4', tempStem: '/tmp/s' })
    expect(plan.scripts.map((s) => s.path)).toEqual(['/tmp/s.sub0.vtt', '/tmp/s.sub1.vtt'])
    expect(plan.scripts[0].content).toBe(VTT)
    expect(plan.temps).toEqual(expect.arrayContaining(['/tmp/s.sub0.vtt', '/tmp/s.sub1.vtt']))
    const args = plan.capture
    expect(args.join(' ')).toContain('-f webvtt -i /tmp/s.sub0.vtt -f webvtt -i /tmp/s.sub1.vtt')
    expect(after(args, '-c:s')).toBe('mov_text')
    expect(args.indexOf('-c:s')).toBeLessThan(args.indexOf('-f', args.indexOf('-movflags')))
  })

  it('puts the streams in the second pass of a two-pass encode only', () => {
    const plan = ffmpegPlan({ ...job, bitrate: { video: 2_000_000, audio: 128_000 } }, { audioInput: null, output: '/o.mp4', tempStem: '/tmp/s' })
    const [pass1, pass2] = plan.passes
    expect(plan.capture).not.toContain('webvtt')
    expect(pass1).not.toContain('webvtt')
    expect(pass2.join(' ')).toContain('-f webvtt -i /tmp/s.sub0.vtt')
    expect(after(pass2, '-map', pass2.indexOf('-pass'))).toBe('1:s')
    expect(after(pass2, '-c:s')).toBe('mov_text')
  })

  it('names the files so a sweep after a crash deletes them', () => {
    const plan = ffmpegPlan(job, { audioInput: null, output: '/o.mp4', tempStem: tempStem(tmpdir()) })
    for (const f of plan.temps) expect(isExportTempFile(f), f).toBe(true)
    expect(plan.temps.some((f) => path.basename(f).endsWith('.sub1.vtt'))).toBe(true)
  })

  it('writes no stream for GIF, nor for an M4A', () => {
    expect(ffmpegPlan({ ...job, format: 'gif' }, { audioInput: null, output: '/o.gif', tempStem: '/tmp/s' }).scripts).toEqual([])
    const m4a = ffmpegPlan({ ...job, format: 'm4a', video: { kind: 'none' }, clicks: { times: [1], volume: 1 } }, { audioInput: null, output: '/o.m4a', tempStem: '/tmp/s' })
    expect(m4a.scripts).toEqual([])
    expect(m4a.capture).not.toContain('webvtt')
  })

  it('checks the streams in main: a WebVTT each, well-formed languages once, one default, video formats only', () => {
    expect(() => validateJob(job)).not.toThrow()
    const bad = (subtitles: unknown, format: ExportJob['format'] = 'mp4'): void => validateJob({ ...job, format, subtitles: subtitles as ExportJob['subtitles'] })
    expect(() => bad([{ language: 'en', name: 'English', vtt: 'not a vtt', default: false }])).toThrow('Invalid export settings')
    expect(() => bad([{ language: '../en', name: 'English', vtt: VTT, default: false }])).toThrow()
    expect(() => bad([job.subtitles![0], job.subtitles![0]])).toThrow()
    expect(() => bad([job.subtitles![0], { ...job.subtitles![1], default: true }])).toThrow()
    expect(() => bad([{ language: 'en', name: 'Eng\nlish', vtt: VTT, default: false }])).toThrow()
    expect(() => bad(Array.from({ length: 9 }, (_, i) => ({ language: `e${String.fromCharCode(97 + i)}`, name: 'X', vtt: VTT, default: false })))).toThrow()
    expect(() => bad(job.subtitles, 'gif')).toThrow()
  })
})

describe('streams and files per language (§11.10)', () => {
  const segs: CaptionSegment[] = [{ id: 'c1', start: 0.5, end: 3, text: 'We make every word count' }]
  const project = {
    id: 'p1',
    clips: [{ id: 'a', start: 0, end: 10, speed: 1 }],
    transcript: { language: 'en', segments: segs },
    captionTracks: [{ language: 'bn', by: 'local', model: 'm', createdAt: '2026-10-31T00:00:00.000Z', segments: [{ id: 'c1', text: 'আমরা আজ শিখব', src: 'x' }] }],
    captions: { show: false, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2 }
  } as unknown as Project
  const vtt = (language: string, spoken: boolean): string => languageSubtitleFile(project, spoken ? null : language, 'vtt')

  it('adds streams only with Also inside the video, and only to MP4, MOV and WebM', () => {
    expect(subtitleStreams(project, { format: 'mp4' }, ['en', 'bn'], vtt)).toEqual([])
    expect(subtitleStreams(project, { format: 'gif', subtitleStreams: true }, ['en', 'bn'], vtt)).toEqual([])
    expect(subtitleStreams(project, { format: 'm4a', subtitleStreams: true }, ['en', 'bn'], vtt)).toEqual([])
    const streams = subtitleStreams(project, { format: 'mov', subtitleStreams: true }, ['bn', 'en'], vtt)
    expect(streams.map((s) => [s.language, s.name, s.default])).toEqual([
      ['en', 'English', true],
      ['bn', 'Bangla', false]
    ])
    expect(streams[1].vtt).toContain('আমরা আজ শিখব')
  })

  it('makes no stream the default when the captions are burned in', () => {
    const burned = { ...project, captions: { ...project.captions!, show: true } }
    expect(subtitleStreams(burned, { format: 'mp4', subtitleStreams: true }, ['en', 'bn'], vtt).map((s) => s.default)).toEqual([false, false])
  })

  it('names a translated language’s files after it, and the spoken one’s as before', () => {
    expect(subtitleLanguages(project, ['bn', 'en', 'fr'])).toEqual(['en', 'bn'])
    expect(subtitleLanguages(project, undefined)).toEqual(['en'])
    expect(sidecarName('Langs.mp4', 'srt')).toBe('Langs.srt')
    expect(sidecarName('Langs.mp4', 'srt', 'bn')).toBe('Langs.bn.srt')
    expect(sidecarName('Langs.mp4', 'vtt', 'pt-BR')).toBe('Langs.pt-BR.vtt')
    expect(sidecarName('Langs.mp4', 'chapters', 'bn')).toBe('Langs - chapters.txt')
    expect(normalizeBundle({ srt: true, languages: ['en', 'bn', '../x', 'bn', 7] })).toEqual({ ...normalizeBundle({ srt: true }), languages: ['en', 'bn'] })
  })

  it('accepts only a language part in main’s sidecar path, for subtitles', () => {
    const deps = { isExported: () => true, replaced: () => false, exists: () => false }
    const anchor = path.resolve('/videos/Langs.mp4')
    expect(sidecarTarget(anchor, 'srt', deps, 'bn')).toBe(path.join(path.dirname(anchor), 'Langs.bn.srt'))
    for (const bad of ['../bn', 'bn/x', 'BN', 'bn-', 7]) expect(() => sidecarTarget(anchor, 'srt', deps, bad)).toThrow('Invalid extra file')
    expect(() => sidecarTarget(anchor, 'chapters', deps, 'bn')).toThrow('Invalid extra file')
  })

  it('masks bleeped words in the spoken subtitles through the burned-in captions’ masks (test 50)', () => {
    const bleeps = [{ id: 'b1', start: 1, end: 1.5, word: 'every', sound: 'tone' as const }]
    masked.mockImplementation((s: readonly CaptionSegment[]) => s.map((x) => ({ ...x, text: x.text.replace('every', 'e****') })))
    const p = { ...project, bleeps }
    expect(spokenSegments(p)[0].text).toBe('We make e**** word count')
    for (const format of ['srt', 'vtt', 'txt'] as const) {
      const text = languageSubtitleFile(p, null, format)
      expect(text).toContain('e****')
      expect(text).not.toContain('every')
    }
    expect(masked).toHaveBeenCalledWith(segs, bleeps)
    masked.mockImplementation((s: readonly CaptionSegment[]) => s)
  })
})
