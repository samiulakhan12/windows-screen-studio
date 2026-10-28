import { describe, expect, it } from 'vitest'
import { proxyArgs } from '../src/main/proxyArgs'
import {
  checkFileSize,
  displaySize,
  etaText,
  gb,
  hasProtectedTrack,
  hitTimeCap,
  importableExtension,
  importArgs,
  importCap,
  importName,
  IMPORT_COPY,
  planImport,
  proxyFpsFor,
  proxySizeFor,
  sniffContainer,
  spaceNeeded,
  TONE_MAP_FILTERS
} from '../src/shared/import/plan'
import type { ProbeInfo, ProbeStream } from '../src/shared/import/probe'

const stream = (over: Partial<ProbeStream>): ProbeStream => ({
  index: 0,
  type: 'video',
  codec: 'h264',
  tag: 'avc1',
  pixFmt: 'yuv420p',
  transfer: null,
  interlaced: false,
  width: 1920,
  height: 1080,
  sar: 1,
  fps: 30,
  attachedPic: false,
  rotation: 0,
  ...over
})
const probe = (streams: ProbeStream[], over: Partial<ProbeInfo> = {}): ProbeInfo => ({ opened: true, container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 60, streams, encrypted: false, ...over })
const audio = (index: number): ProbeStream => stream({ index, type: 'audio', codec: 'aac', tag: 'mp4a', width: null, height: null, fps: null, pixFmt: null, sar: null })
const plan = (p: ProbeInfo, toneMap = true) => {
  const r = planImport(p, { toneMap })
  if (!r.ok) throw new Error(r.error)
  return r.plan
}
const refusal = (p: ProbeInfo): string => {
  const r = planImport(p, { toneMap: true })
  return r.ok ? 'accepted' : r.error
}

describe('file checks', () => {
  it('accepts the listed extensions only, in any case', () => {
    for (const f of ['a.mp4', 'b.MOV', 'c.mkv', 'd.webm', 'e.m4v']) expect(importableExtension(f)).toBe(true)
    for (const f of ['a.avi', 'b.m4a', 'c', 'mp4', 'd.mp4.exe', 'e.wmv']) expect(importableExtension(f)).toBe(false)
  })

  it('sniffs MP4/MOV boxes and Matroska, nothing else', () => {
    const box = (type: string): Uint8Array => new Uint8Array([0, 0, 0, 24, ...[...type].map((c) => c.charCodeAt(0)), 0, 0, 0, 0])
    for (const t of ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']) expect(sniffContainer(box(t))).toBe('mp4')
    expect(sniffContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))).toBe('matroska')
    expect(sniffContainer(box('RIFF'))).toBeNull()
    expect(sniffContainer(new TextEncoder().encode('<html><body>'))).toBeNull()
    expect(sniffContainer(new Uint8Array([0, 0, 0]))).toBeNull()
  })

  it('checks the file size', () => {
    expect(checkFileSize(0)).toBe(IMPORT_COPY.empty)
    expect(checkFileSize(1023)).toBe(IMPORT_COPY.empty)
    expect(checkFileSize(1024)).toBeNull()
    expect(checkFileSize(64 * 1024 ** 3)).toBeNull()
    expect(checkFileSize(64 * 1024 ** 3 + 1)).toBe(IMPORT_COPY.tooLarge)
    expect(checkFileSize(NaN)).toBe(IMPORT_COPY.empty)
  })

  it('finds a protected sample entry (sinf with frma) only', () => {
    const bytes = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
    expect(hasProtectedTrack(bytes('....encv....sinf\0\0\0\x0cfrmaavc1................'))).toBe(true)
    expect(hasProtectedTrack(bytes('....avc1....sinf\0\0\0\x0cmdatavc1................'))).toBe(false)
    expect(hasProtectedTrack(bytes('sinf'))).toBe(false)
  })

  it('names the project after the file', () => {
    expect(importName('C:\\Videos\\Demo take 2.mp4')).toBe('Demo take 2')
    expect(importName('/home/me/clip.final.webm')).toBe('clip.final')
    expect(importName('tab\there\nnew  line.mov')).toBe('tab here new line')
    expect(importName('.mp4')).toBe('Imported video')
    expect(importName(`${'é'.repeat(200)}.mkv`)).toHaveLength(120)
  })
})

describe('planImport', () => {
  it('plans a plain 1080p30 video with sound', () => {
    const p = plan(probe([stream({}), audio(1)]))
    expect(p).toMatchObject({ videoStream: 0, audioStream: 1, audioTracks: 1, fps: 30, size: { width: 1920, height: 1080 }, duration: 60, preFilters: [], hdr: false, notes: [] })
    expect(p.source).toEqual({ kind: 'import', container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, rotation: 0, fps: 30 })
  })

  it('skips cover art and uses the first sound of several, with a note', () => {
    const p = plan(probe([stream({ index: 0, codec: 'png', attachedPic: true }), stream({ index: 1 }), audio(2), audio(3), audio(4)]))
    expect([p.videoStream, p.audioStream]).toEqual([1, 2])
    expect(p.notes).toEqual([IMPORT_COPY.noteTracks(3)])
  })

  it('refuses files without a usable picture', () => {
    expect(refusal(probe([], { opened: false }))).toBe(IMPORT_COPY.unreadable)
    expect(refusal(probe([audio(0)]))).toBe(IMPORT_COPY.soundOnly)
    expect(refusal(probe([stream({ codec: 'mjpeg', attachedPic: true }), audio(1)]))).toBe(IMPORT_COPY.soundOnly)
    expect(refusal(probe([stream({ type: 'subtitle', codec: 'mov_text' })]))).toBe(IMPORT_COPY.noVideo)
    expect(refusal(probe([stream({ codec: 'none', tag: 'apcn' })]))).toBe(IMPORT_COPY.codec('apcn'))
    expect(refusal(probe([stream({})], { encrypted: true }))).toBe(IMPORT_COPY.drm)
  })

  it('refuses lengths and sizes outside the limits', () => {
    expect(refusal(probe([stream({})], { duration: 0 }))).toBe(IMPORT_COPY.tooShort)
    expect(refusal(probe([stream({})], { duration: 0.49 }))).toBe(IMPORT_COPY.tooShort)
    expect(refusal(probe([stream({})], { duration: 0.5 }))).toBe('accepted')
    expect(refusal(probe([stream({})], { duration: 4 * 3600 }))).toBe('accepted')
    expect(refusal(probe([stream({})], { duration: 4 * 3600 + 1 }))).toBe(IMPORT_COPY.tooLong)
    expect(refusal(probe([stream({ width: 15, height: 15 })]))).toBe(IMPORT_COPY.size(15, 15))
    expect(refusal(probe([stream({ width: 20000, height: 10000 })]))).toBe(IMPORT_COPY.size(20000, 10000))
    expect(refusal(probe([stream({ width: null, height: null })]))).toBe(IMPORT_COPY.size(0, 0))
    expect(refusal(probe([stream({ width: 16, height: 160 })]))).toBe('accepted')
    expect(refusal(probe([stream({ width: 16, height: 161 })]))).toBe(IMPORT_COPY.narrow(16, 161))
  })

  it('accepts an unknown length (live WebM) and caps it at 4 hours', () => {
    const p = plan(probe([stream({})], { duration: null }))
    expect(p.duration).toBeNull()
    const args = importArgs(proxyArgs('in.webm', 'out.mp4', false, { fps: 30, size: p.size, progress: true }), p)
    expect(args.slice(-3)).toEqual(['-t', '14400', 'out.mp4'])
  })

  it('rotates, fixes non-square pixels and odd sizes', () => {
    expect(plan(probe([stream({ width: 1920, height: 1080, rotation: 90 })])).size).toEqual({ width: 1080, height: 1920 })
    expect(plan(probe([stream({ width: 1920, height: 1080, rotation: 270 })])).size).toEqual({ width: 1080, height: 1920 })
    expect(plan(probe([stream({ width: 1920, height: 1080, rotation: 180 })])).size).toEqual({ width: 1920, height: 1080 })
    expect(plan(probe([stream({ width: 641, height: 361 })])).size).toEqual({ width: 640, height: 360 })
    expect(displaySize({ width: 720, height: 576, sar: 16 / 15, rotation: 0 })).toEqual({ width: 768, height: 576 })
    const dv = plan(probe([stream({ width: 720, height: 576, sar: 16 / 15 })]))
    expect(dv.size).toEqual({ width: 768, height: 576 })
    expect(dv.preFilters).toEqual(['scale=w=trunc(iw*sar/2)*2:h=ih', 'setsar=1'])
  })

  it('fits larger-than-4K pictures inside 3840 × 2160 either way, with a note', () => {
    expect(proxySizeFor({ width: 3840, height: 2160 })).toEqual({ width: 3840, height: 2160 })
    expect(proxySizeFor({ width: 2160, height: 3840 })).toEqual({ width: 2160, height: 3840 })
    expect(proxySizeFor({ width: 5760, height: 2880 })).toEqual({ width: 3840, height: 1920 })
    expect(proxySizeFor({ width: 4096, height: 2160 })).toEqual({ width: 3840, height: 2024 })
    expect(proxySizeFor({ width: 7680, height: 4320 })).toEqual({ width: 3840, height: 2160 })
    const p = plan(probe([stream({ width: 5760, height: 2880 })]))
    expect(p.notes).toEqual([IMPORT_COPY.noteScaled(3840, 1920)])
    expect(plan(probe([stream({ width: 3840, height: 2160 })])).notes).toEqual([])
  })

  it('picks 30 or 60 fps (variable rates become constant)', () => {
    expect(proxyFpsFor(null)).toBe(30)
    expect(proxyFpsFor(23.976)).toBe(30)
    expect(proxyFpsFor(25)).toBe(30)
    expect(proxyFpsFor(29.97)).toBe(30)
    expect(proxyFpsFor(31)).toBe(30)
    expect(proxyFpsFor(31.5)).toBe(60)
    expect(proxyFpsFor(59.81)).toBe(60)
    expect(proxyFpsFor(120)).toBe(60)
  })

  it('deinterlaces and tone-maps HDR when the filters exist, with a note either way', () => {
    expect(plan(probe([stream({ interlaced: true })])).preFilters).toEqual(['yadif'])
    const hdr = plan(probe([stream({ transfer: 'smpte2084' })]), true)
    expect(hdr).toMatchObject({ hdr: true, toneMapped: true, preFilters: TONE_MAP_FILTERS, notes: [IMPORT_COPY.noteHdr] })
    expect(hdr.source.hdr).toBe(true)
    const pale = plan(probe([stream({ transfer: 'arib-std-b67' })]), false)
    expect(pale).toMatchObject({ hdr: true, toneMapped: false, preFilters: [], notes: [IMPORT_COPY.noteHdrPale] })
    expect(pale.source.hdr).toBe(false)
    expect('hdr' in plan(probe([stream({})])).source).toBe(false)
  })
})

describe('importArgs', () => {
  const base = proxyArgs('in.mkv', 'out.mp4', true, { fps: 30, size: { width: 640, height: 360 }, progress: true })

  it('maps the chosen streams by index and puts the plan filters first', () => {
    const args = importArgs(base, { videoStream: 1, audioStream: 3, preFilters: ['yadif'], duration: 10 })
    expect(args).not.toContain('0:v:0')
    expect(args).not.toContain('0:a:0?')
    expect(args.join(' ')).toContain('-map 0:1 -map 0:3')
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^yadif,scale=/)
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('always caps the length: the stated length and 2 s more, at most 4 hours', () => {
    // The encode follows the packets' timestamps: a header that says 10 s cannot make it run for hours.
    expect(importArgs(base, { videoStream: 0, audioStream: 1, preFilters: [], duration: 10 }).slice(-3)).toEqual(['-t', '12', 'out.mp4'])
    expect(importArgs(base, { videoStream: 0, audioStream: 1, preFilters: [], duration: 9.2 }).slice(-3)).toEqual(['-t', '12', 'out.mp4'])
    expect(importCap(4 * 3600 - 1)).toBe(4 * 3600)
    expect(importCap(null)).toBe(4 * 3600)
  })

  it('says the 4-hour cap cut the copy only when the file had more than that', () => {
    expect(hitTimeCap(null, 4 * 3600)).toBe(true)
    expect(hitTimeCap(null, 3600)).toBe(false)
    // A header that understated a longer video, cut at 4 hours.
    expect(hitTimeCap(4 * 3600 - 2, 4 * 3600)).toBe(true)
    // A video of just under 4 hours, imported whole.
    expect(hitTimeCap(4 * 3600 - 0.5, 4 * 3600 - 0.5)).toBe(false)
  })

  it('drops the sound map when there is no sound to use', () => {
    const args = importArgs(base, { videoStream: 0, audioStream: null, preFilters: [], duration: 10 })
    expect(args.filter((a) => a === '-map')).toHaveLength(1)
    expect(args[args.indexOf('-vf') + 1]).toBe(base[base.indexOf('-vf') + 1])
  })

  it('throws when proxyArgs changed shape', () => {
    expect(() => importArgs(['-i', 'x', 'out.mp4'], { videoStream: 0, audioStream: null, preFilters: [], duration: 1 })).toThrow(/0:v:0/)
  })
})

describe('space and time left', () => {
  it('estimates the space from the editing copy', () => {
    const mb = 1024 ** 2
    // 1 h 1080p30: 9.33 Mbit/s → 4.2 GB × 1.25 + 512 MB.
    expect(spaceNeeded({ size: { width: 1920, height: 1080 }, fps: 30, duration: 3600 }, 0) / 1024 ** 3).toBeCloseTo(5.39, 1)
    // Small pictures use the 4 Mbit/s floor; 4K60 the 40 Mbit/s ceiling.
    expect(spaceNeeded({ size: { width: 320, height: 240 }, fps: 30, duration: 8 }, 0)).toBe(Math.ceil((4e6 / 8) * 8 * 1.25 + 512 * mb))
    expect(spaceNeeded({ size: { width: 3840, height: 2160 }, fps: 60, duration: 1 }, 0)).toBe(Math.ceil((40e6 / 8) * 1.25 + 512 * mb))
    // Unknown length: twice the file.
    expect(spaceNeeded({ size: { width: 1920, height: 1080 }, fps: 30, duration: null }, 1000 * mb)).toBe(2512 * mb)
    expect(IMPORT_COPY.space(5.7 * 1024 ** 3, 2.1 * 1024 ** 3)).toBe('There is not enough free space for this video: it needs about 5.7 GB and 2.1 GB is free.')
    expect(gb(100 * mb)).toBe('100 MB')
  })

  it('says how long is left once it can tell', () => {
    expect(etaText(4, 0.5)).toBeNull()
    expect(etaText(10, 0.02)).toBeNull()
    expect(etaText(10, null)).toBeNull()
    expect(etaText(10, 1)).toBeNull()
    expect(etaText(10, 0.5)).toBe('Less than a minute left')
    expect(etaText(60, 0.25)).toBe('About 3 min left')
  })
})
