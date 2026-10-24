import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chapterMetadata, exportArgs, ffmpegPlan } from '../src/main/exportArgs'
import { ffmpegPath } from '../src/main/ffmpeg'
import { validateJob } from '../src/main/exportJob'
import type { ExportJob } from '../src/shared/api/export'
import { formatTimestamp, MAX_CHAPTERS, outputChapters, youtubeChapters } from '../src/shared/render/chapters'
import type { Chapter, Clip } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
const ch = (t: number, title: string, id = title): Chapter => ({ id, t, title })

describe('outputChapters: source chapters on the edited video', () => {
  it('maps source times through cuts and speed changes', () => {
    // Kept: 0-10 (1x), 20-30 (2x) -> output 0-10, 10-15.
    const clips = [clip(0, 10), clip(20, 30, 2)]
    expect(outputChapters([ch(0, 'Intro'), ch(4, 'Setup'), ch(24, 'Demo')], clips)).toEqual([
      { start: 0, title: 'Intro' },
      { start: 4, title: 'Setup' },
      { start: 12, title: 'Demo' }
    ])
  })

  it('moves a chapter inside a cut to where the video goes on, and a trimmed start to 0', () => {
    const clips = [clip(2, 10), clip(20, 30)]
    expect(outputChapters([ch(0, 'Intro'), ch(15, 'Cut away')], clips)).toEqual([
      { start: 0, title: 'Intro' },
      { start: 8, title: 'Cut away' }
    ])
  })

  it('keeps one chapter per place: the later one in the recording', () => {
    const clips = [clip(0, 10), clip(20, 30)]
    // 12 (in the cut) and 20 both land at output 10.
    expect(outputChapters([ch(12, 'Gone'), ch(20, 'Kept'), ch(0, 'A'), ch(0.05, 'B')], clips)).toEqual([
      { start: 0.05, title: 'B' },
      { start: 10, title: 'Kept' }
    ])
  })

  it('leaves out chapters at or after the end, and names unnamed ones', () => {
    const clips = [clip(0, 10)]
    expect(outputChapters([ch(0, '  '), ch(5, 'Two\nlines'), ch(10, 'End'), ch(12, 'Past')], clips)).toEqual([
      { start: 0, title: 'Chapter 1' },
      { start: 5, title: 'Two lines' }
    ])
    expect(outputChapters([], clips)).toEqual([])
  })

  it('never returns more than MAX_CHAPTERS', () => {
    const many = Array.from({ length: MAX_CHAPTERS + 50 }, (_, i) => ch(i * 0.2, `C${i}`))
    expect(outputChapters(many, [clip(0, 10_000)])).toHaveLength(MAX_CHAPTERS)
  })
})

describe('YouTube timestamps', () => {
  const good = [
    { start: 0, title: 'Intro' },
    { start: 12.7, title: 'Setup' },
    { start: 75, title: 'Demo' }
  ]

  it('formats minutes and hours', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(65.9)).toBe('1:05')
    expect(formatTimestamp(3723, true)).toBe('1:02:03')
    expect(formatTimestamp(61, true)).toBe('0:01:01')
    expect(formatTimestamp(-4)).toBe('0:00')
  })

  it('lists "0:00 Intro" lines and accepts a list YouTube would use', () => {
    expect(youtubeChapters(good, 100)).toEqual({ text: '0:00 Intro\n0:12 Setup\n1:15 Demo', problems: [] })
    expect(youtubeChapters(good, 4000).text.split('\n')[2]).toBe('0:01:15 Demo')
  })

  it('says why a list does not qualify', () => {
    expect(youtubeChapters([], 100).problems).toEqual(['Add chapters first.'])
    expect(youtubeChapters(good.slice(1), 100).problems.join(' ')).toMatch(/first chapter at 0:00.*at least 3/)
    expect(youtubeChapters(good, 80).problems).toEqual(['YouTube needs every chapter to last at least 10 seconds ("Demo" is shorter).'])
    expect(youtubeChapters([good[0], { start: 5, title: 'Short' }, good[2]], 100).problems[0]).toMatch(/"Intro" is shorter/)
  })

  it('merges chapters in the same second', () => {
    expect(youtubeChapters([{ start: 0, title: 'A' }, { start: 0.4, title: 'B' }], 30).text).toBe('0:00 B')
  })
})

describe('chapter metadata in exports', () => {
  const job: ExportJob = {
    width: 1280,
    height: 720,
    fps: 30,
    frames: 300,
    format: 'mp4',
    quality: 'high',
    video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
    chapters: [
      { start: 0, title: 'Intro' },
      { start: 4.25, title: 'Set = up; #1 \\ go' }
    ],
    outputPath: '/videos/out.mp4'
  }

  it('writes [CHAPTER] entries in milliseconds, each ending at the next, the last at the end', () => {
    expect(chapterMetadata(job.chapters!, 10)).toBe(
      [';FFMETADATA1', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=4250', 'title=Intro', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=4250', 'END=10000', 'title=Set \\= up\\; \\#1 \\\\ go', ''].join('\n')
    )
  })

  it('leaves out empty chapters and returns null without any', () => {
    expect(chapterMetadata([{ start: 12, title: 'Past the end' }], 10)).toBeNull()
    expect(chapterMetadata([], 10)).toBeNull()
    const meta = chapterMetadata([{ start: 0, title: 'A' }, { start: 0.0001, title: 'B' }, { start: 9.9999, title: 'C' }], 10)!
    expect(meta.match(/\[CHAPTER\]/g)).toHaveLength(1)
    expect(meta).toContain('title=B')
  })

  it('adds the chapters file as an input and maps its chapters (raw, WebCodecs, audio only, two pass)', () => {
    const io = { audioInput: '/p/screen.mp4', output: '/videos/.out.partial.mp4', chapters: '/tmp/x.chapters.txt' }
    const withAudio = exportArgs({ ...job, audio: { clips: [clip(0, 10)], volume: 1 } }, io)
    const at = withAudio.indexOf('/tmp/x.chapters.txt')
    expect(withAudio.slice(at - 3, at + 1)).toEqual(['-f', 'ffmetadata', '-i', '/tmp/x.chapters.txt'])
    // Inputs: frames (0), the recording's sound (1), the chapters (2).
    expect(withAudio[withAudio.indexOf('-map_chapters') + 1]).toBe('2')
    expect(withAudio.indexOf('-map_chapters')).toBeLessThan(withAudio.indexOf('-movflags'))
    const m4a = exportArgs({ ...job, format: 'm4a', video: { kind: 'none' }, audio: { clips: [clip(0, 10)], volume: 1 } }, io)
    expect(m4a[m4a.indexOf('-map_chapters') + 1]).toBe('1')
    // Without a chapters file nothing changes.
    expect(exportArgs(job, { ...io, chapters: null })).not.toContain('-map_chapters')

    const plan = ffmpegPlan(job, { audioInput: null, output: '/videos/.out.partial.mp4', tempStem: '/tmp/screen-studio-gif-1' })
    expect(plan.scripts).toEqual([{ path: '/tmp/screen-studio-gif-1.chapters.txt', content: chapterMetadata(job.chapters!, 10) }])
    expect(plan.temps).toContain('/tmp/screen-studio-gif-1.chapters.txt')
    expect(plan.capture[plan.capture.indexOf('-map_chapters') + 1]).toBe('1')
    const twoPass = ffmpegPlan({ ...job, bitrate: { video: 2_000_000, audio: 128_000 } }, { audioInput: null, output: '/o.mp4', tempStem: '/tmp/s' })
    expect(twoPass.capture).not.toContain('-map_chapters')
    expect(twoPass.passes[1][twoPass.passes[1].indexOf('-map_chapters') + 1]).toBe('1')
    expect(twoPass.temps).toContain('/tmp/s.chapters.txt')
    // A job without chapters writes no file.
    expect(ffmpegPlan({ ...job, chapters: undefined }, { audioInput: null, output: '/o.mp4', tempStem: '/tmp/s' }).scripts).toEqual([])
  })

  it('accepts only ordered, named chapters, and none for GIFs', () => {
    expect(() => validateJob(job)).not.toThrow()
    expect(() => validateJob({ ...job, chapters: [] })).not.toThrow()
    const bad = (chapters: unknown, format: ExportJob['format'] = 'mp4'): void => expect(() => validateJob({ ...job, format, chapters } as ExportJob)).toThrow(/Invalid export settings/)
    bad([{ start: 2, title: 'B' }, { start: 1, title: 'A' }])
    bad([{ start: 1, title: 'A' }, { start: 1, title: 'A again' }])
    bad([{ start: -1, title: 'A' }])
    bad([{ start: Number.NaN, title: 'A' }])
    bad([{ start: 0, title: 3 }])
    bad([{ start: 0, title: 'x'.repeat(501) }])
    bad([null])
    bad('0:00 Intro')
    bad(Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => ({ start: i, title: 'C' })))
    bad(job.chapters, 'gif')
  })

  describe('ffmpeg writes them into every container', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-chapters-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const meta = path.join(dir, 'chapters.txt')
    writeFileSync(meta, chapterMetadata([{ start: 0, title: 'Intro' }, { start: 1.5, title: 'Set = up; #2' }], 3)!)
    const tone = path.join(dir, 'tone.m4a')
    execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'aac', tone])
    const probe = (file: string): { start_time: string; end_time: string; tags: { title: string } }[] =>
      JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', file]).toString()).chapters

    for (const format of ['mp4', 'mov', 'webm', 'm4a'] as const) {
      it(format, () => {
        const out = path.join(dir, `out.${format}`)
        const audioOnly = format === 'm4a'
        const video: ExportJob['video'] = audioOnly ? { kind: 'none' } : { kind: 'raw', encoder: format === 'webm' ? 'libvpx-vp9' : 'libx264', pixelFormat: 'rgba' }
        const args = exportArgs({ ...job, width: 320, height: 240, format, frames: 90, video, audio: { clips: [clip(0, 3)], volume: 1 } }, { audioInput: tone, output: out, chapters: meta })
        // 90 black RGBA frames on stdin.
        execFileSync(ffmpegPath(), args, { input: audioOnly ? undefined : Buffer.alloc(320 * 240 * 4 * 90), maxBuffer: 1 << 26 })
        expect(probe(out).map((c) => [Number(c.start_time), Number(c.end_time), c.tags.title])).toEqual([
          [0, 1.5, 'Intro'],
          [1.5, 3, 'Set = up; #2']
        ])
      }, 30000)
    }
  })
})
