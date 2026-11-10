/**
 * Tests 37, 38 and 39 (docs/design/output-and-languages.md §23.1, §8.3–8.6): the FCPXML, Premiere XML
 * and EDL writers against golden files in tests/fixtures/timelines, and the rules each golden shows,
 * checked on the parsed documents. The FCPXML goldens were checked against Apple's FCPXML 1.10 DTD
 * with `xmllint --dtdvalid` when they were made. Goldens are kept with LF line ends; the EDLs are
 * compared after turning them into CRLF, and the writers' own line ends are checked apart.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EDL_EVENT_LIMIT, edl, markerEdl } from '../src/shared/interchange/edl'
import { fcpxml } from '../src/shared/interchange/fcpxml'
import { exportTimeline, recordingsTimeline, type TimelinePlan } from '../src/shared/interchange/timelinePlan'
import { xmeml } from '../src/shared/interchange/xmeml'
import { childrenOf, findAll, parseXml, textOf, type XmlElement } from './strictXml'
import { GOLDEN_EXPORT_PATHS, GOLDEN_MEDIA, GOLDEN_RECORDING_PATHS, goldenProject } from './timelineFixtures'

const golden = (name: string): string => readFileSync(path.join(__dirname, 'fixtures', 'timelines', name), 'utf8').replace(/\r\n/g, '\n')
const crlf = (text: string): string => text.replace(/\n/g, '\r\n')

const project = goldenProject()
const exported = { fps: 30, frames: 450, width: 1920, height: 1080 }
const withStems = (): TimelinePlan => exportTimeline(project, exported, ['voice', 'system', 'music'])
const plain = (): TimelinePlan => exportTimeline(project, exported, [])
const recordings = (): TimelinePlan => recordingsTimeline(project, 30, GOLDEN_MEDIA)

const spineClips = (doc: XmlElement): XmlElement[] => childrenOf(findAll(doc, 'spine')[0], 'asset-clip')

describe('test 37: fcpxml', () => {
  it('equals the golden files', () => {
    expect(fcpxml(plain(), GOLDEN_EXPORT_PATHS, project.id)).toBe(golden('export.fcpxml'))
    expect(fcpxml(withStems(), GOLDEN_EXPORT_PATHS, project.id)).toBe(golden('export-stems.fcpxml'))
    expect(fcpxml(recordings(), GOLDEN_RECORDING_PATHS, project.id)).toBe(golden('recordings.fcpxml'))
  })

  it('export mode: V1 picture only with stems and whole without, the stems connected below with their roles', () => {
    const stems = parseXml(fcpxml(withStems(), GOLDEN_EXPORT_PATHS, project.id))
    expect(stems.attrs.version).toBe('1.10')
    const [v1] = spineClips(stems)
    expect(v1.attrs.srcEnable).toBe('video')
    expect(childrenOf(v1, 'asset-clip').map((c) => [c.attrs.lane, c.attrs.audioRole, c.attrs.offset, c.attrs.duration])).toEqual([
      ['-1', 'dialogue', '0s', '450/30s'],
      ['-2', 'effects', '0s', '450/30s'],
      ['-3', 'music', '0s', '450/30s']
    ])
    const none = parseXml(fcpxml(plain(), GOLDEN_EXPORT_PATHS, project.id))
    expect(spineClips(none)[0].attrs.srcEnable).toBeUndefined()
    expect(findAll(none, 'asset')).toHaveLength(1)
    expect(findAll(none, 'asset')[0].attrs.hasAudio).toBe('1')
  })

  it('recordings mode: speed, hold, dissolve, roles, the camera turned off and no sound in the remuxed files', () => {
    const doc = parseXml(fcpxml(recordings(), GOLDEN_RECORDING_PATHS, project.id))
    const assets = new Map(findAll(doc, 'asset').map((a) => [a.attrs.name, a]))
    expect(assets.get('Screen')!.attrs).toMatchObject({ hasVideo: '1', hasAudio: '0', duration: '1200/60s' })
    expect(assets.get('Camera')!.attrs).toMatchObject({ hasVideo: '1', hasAudio: '0' })
    expect(assets.get('Voice')!.attrs).toMatchObject({ hasVideo: '0', hasAudio: '1', audioRate: '48000' })
    expect(assets.get('Screen')!.attrs.uid).toMatch(/^flown\.p6f1c\.\d+$/)
    expect(findAll(assets.get('Screen')!, 'media-rep')[0].attrs.src).toBe('file:///C:/Users/%E0%A6%B0%E0%A6%B9%E0%A6%BF%E0%A6%AE/Videos/Demo%20%231%20media/Screen.mp4')
    // Uids are stable for the same files and differ between them.
    expect(new Set(findAll(doc, 'asset').map((a) => a.attrs.uid)).size).toBe(assets.size)
    expect(fcpxml(recordings(), GOLDEN_RECORDING_PATHS, project.id)).toBe(fcpxml(recordings(), GOLDEN_RECORDING_PATHS, project.id))

    const clips = spineClips(doc)
    // Clip b at 2x: a linear timeMap from its source in to its source out over its timeline length.
    const fast = clips[1]
    expect(childrenOf(childrenOf(fast, 'timeMap')[0], 'timept').map((p) => [p.attrs.time, p.attrs.value, p.attrs.interp])).toEqual([
      ['120/30s', '300/60s', 'linear'],
      ['180/30s', '540/60s', 'linear']
    ])
    // The pause freeze: a hold, both values the held frame.
    const hold = clips[3]
    const holdPoints = childrenOf(childrenOf(hold, 'timeMap')[0], 'timept').map((p) => p.attrs.value)
    expect(holdPoints).toEqual(['660/60s', '660/60s'])
    // The crossfade into clip d: a Cross Dissolve in the spine at the cut, half a second long.
    const spine = findAll(doc, 'spine')[0]
    const transitions = childrenOf(spine, 'transition')
    expect(transitions.map((t) => [t.attrs.name, t.attrs.offset, t.attrs.duration])).toEqual([['Cross Dissolve', '330/30s', '15/30s']])
    const order = spine.children.filter((c): c is XmlElement => typeof c !== 'string').map((c) => c.name)
    expect(order.indexOf('transition')).toBe(order.length - 2)
    // V2 above, turned off; the sound below with its roles; a gap in the sound at the hold.
    const camera = findAll(doc, 'asset-clip').filter((c) => c.attrs.lane === '1')
    expect(camera.length).toBeGreaterThan(0)
    for (const c of camera) expect(c.attrs.enabled).toBe('0')
    expect(childrenOf(hold, 'asset-clip').map((c) => c.attrs.name)).toEqual(['Camera'])
    expect(new Set(findAll(doc, 'asset-clip').filter((c) => c.attrs.lane === '-1').map((c) => c.attrs.audioRole))).toEqual(new Set(['dialogue']))
    expect(new Set(findAll(doc, 'asset-clip').filter((c) => c.attrs.lane === '-2').map((c) => c.attrs.audioRole))).toEqual(new Set(['effects']))
    // Chapter markers with their names, the Bangla one whole and the escaped one read back as written.
    expect(findAll(doc, 'chapter-marker').map((m) => [m.attrs.value, m.attrs.duration])).toEqual([
      ['Intro', '1/30s'],
      ['ভূমিকা', '1/30s'],
      ['Settings <page> & "more"', '1/30s']
    ])
    expect(findAll(doc, 'project')[0].attrs.name).toBe('Demo & "Tour" <1>')
    // Every time is a rational of whole frames or 0s, never a decimal.
    for (const el of findAll(doc, 'asset-clip')) for (const k of ['offset', 'start', 'duration']) expect(el.attrs[k]).toMatch(/^(0s|\d+\/\d+s)$/)
  })
})

describe('test 38: xmeml', () => {
  it('equals the golden files', () => {
    expect(xmeml(plain(), GOLDEN_EXPORT_PATHS)).toBe(golden('export.xml'))
    expect(xmeml(withStems(), GOLDEN_EXPORT_PATHS)).toBe(golden('export-stems.xml'))
    expect(xmeml(recordings(), GOLDEN_RECORDING_PATHS)).toBe(golden('recordings.xml'))
  })

  it('has no audio clip items for V1 with stems and linked ones without', () => {
    const stems = parseXml(xmeml(withStems(), GOLDEN_EXPORT_PATHS))
    const audioNames = (doc: XmlElement): string[] => findAll(findAll(doc, 'audio').find((a) => childrenOf(a, 'track').length > 0)!, 'clipitem').map((c) => textOf(c, 'name'))
    expect(audioNames(stems)).toEqual(['Demo #1 - Voice.wav', 'Demo #1 - System sound.wav', 'Demo #1 - Music.wav'])
    const none = parseXml(xmeml(plain(), GOLDEN_EXPORT_PATHS))
    expect(audioNames(none)).toEqual(['Demo #1.mp4'])
    const audioItem = findAll(none, 'clipitem')[1]
    expect(childrenOf(audioItem, 'link').map((l) => textOf(l, 'linkclipref'))).toEqual(['clipitem-1', 'clipitem-2'])
  })

  it('writes the sequence at the plan size and rate, pathurls in Premiere form, time remap, holds, the camera off and the markers', () => {
    const doc = parseXml(xmeml(recordings(), GOLDEN_RECORDING_PATHS))
    expect(doc.attrs.version).toBe('4')
    const sequence = childrenOf(doc, 'sequence')[0]
    expect(textOf(sequence, 'name')).toBe('Demo & "Tour" <1>')
    expect(textOf(sequence, 'duration')).toBe('450')
    const sample = findAll(childrenOf(findAll(sequence, 'video')[0], 'format')[0], 'samplecharacteristics')[0]
    expect([textOf(sample, 'width'), textOf(sample, 'height')]).toEqual(['1920', '1080'])
    expect(textOf(findAll(sample, 'rate')[0], 'timebase')).toBe('30')
    expect(textOf(findAll(sample, 'rate')[0], 'ntsc')).toBe('FALSE')
    expect(findAll(doc, 'pathurl').map((p) => textOf(p))[0]).toBe('file://localhost/C:/Users/%E0%A6%B0%E0%A6%B9%E0%A6%BF%E0%A6%AE/Videos/Demo%20%231%20media/Screen.mp4')
    const tracks = childrenOf(findAll(sequence, 'video')[0], 'track')
    const v1 = childrenOf(tracks[0], 'clipitem')
    const speedOf = (c: XmlElement): string | null => {
      const p = findAll(c, 'parameter').find((x) => textOf(x, 'parameterid') === 'speed')
      return p ? textOf(p, 'value') : null
    }
    expect(v1.map(speedOf)).toEqual([null, '200', '50', '0', '50', null])
    expect(v1.map((c) => [textOf(c, 'start'), textOf(c, 'end'), textOf(c, 'in'), textOf(c, 'out')])[3]).toEqual(['240', '270', '660', '661'])
    const hold = findAll(v1[3], 'parameter').find((x) => textOf(x, 'parameterid') === 'frameblending')!
    expect(textOf(hold, 'value')).toBe('FALSE')
    const transition = childrenOf(tracks[0], 'transitionitem')[0]
    expect([textOf(transition, 'start'), textOf(transition, 'end'), textOf(findAll(transition, 'effect')[0], 'name')]).toEqual(['330', '345', 'Cross Dissolve'])
    for (const c of childrenOf(tracks[1], 'clipitem')) expect(textOf(c, 'enabled')).toBe('FALSE')
    for (const c of v1) expect(childrenOf(c, 'enabled')).toEqual([])
    expect(childrenOf(sequence, 'marker').map((m) => [textOf(m, 'name'), textOf(m, 'in')])).toEqual([
      ['Intro', '0'],
      ['ভূমিকা', '128'],
      ['Settings <page> & "more"', '360']
    ])
  })

  it('writes a level as Audio Levels, linear', () => {
    const plan = withStems()
    plan.tracks[3].events[0].gainDb = -3
    const doc = parseXml(xmeml(plan, GOLDEN_EXPORT_PATHS))
    const level = findAll(doc, 'parameter').find((p) => textOf(p, 'parameterid') === 'level')!
    expect(textOf(level, 'value')).toBe('0.707946')
  })
})

describe('test 39: edl and markerEdl', () => {
  it('equal their golden files, in CRLF', () => {
    const text = edl(plain(), GOLDEN_EXPORT_PATHS)
    expect(text).toBe(crlf(golden('export.edl')))
    expect(markerEdl(plain())).toBe(crlf(golden('markers.edl')))
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(markerEdl(plain())!.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('writes one AA/V event, non-drop frame, with the file named for linking', () => {
    const lines = edl(withStems(), GOLDEN_EXPORT_PATHS).split('\r\n')
    expect(lines[0]).toBe('TITLE: Demo & "Tour" <1>')
    expect(lines[1]).toBe('FCM: NON-DROP FRAME')
    const events = lines.filter((l) => /^\d{3} /.test(l))
    expect(events).toEqual(['001  AX       AA/V  C        00:00:00:00 00:00:15:00 00:00:00:00 00:00:15:00'])
    expect(lines).toContain('* FROM CLIP NAME: Demo #1.mp4')
    expect(lines).toContain('* SOURCE FILE: C:\\Users\\রহিম\\Videos\\Demo #1.mp4')
  })

  it('writes a 120 fps export at the timeline\'s 60 fps', () => {
    const at120 = exportTimeline(project, { fps: 120, frames: 1800, width: 1920, height: 1080 }, [])
    expect(at120.fps).toBe(60)
    expect(edl(at120, GOLDEN_EXPORT_PATHS)).toBe(crlf(golden('export-120.edl')))
    expect(edl(at120, GOLDEN_EXPORT_PATHS)).toContain('00:00:00:00 00:00:15:00 00:00:00:00 00:00:15:00')
  })

  it('names a Bangla chapter "Chapter 2" in the marker EDL only, and gives null without chapters', () => {
    const markers = markerEdl(plain())!
    expect(markers).toContain(' |C:ResolveColorBlue |M:Chapter 2 |D:1\r\n')
    expect(markers).not.toContain('ভূমিকা')
    expect(fcpxml(plain(), GOLDEN_EXPORT_PATHS, project.id)).toContain('value="ভূমিকা"')
    expect(xmeml(plain(), GOLDEN_EXPORT_PATHS)).toContain('<name>ভূমিকা</name>')
    expect(markerEdl({ ...plain(), markers: [] })).toBeNull()
    expect(markerEdl({ ...plain(), markers: [{ frame: 3, name: 'a | b', chapter: true }] })).toContain('|M:a / b |D:1')
  })

  it('refuses more than EDL_EVENT_LIMIT events', () => {
    const plan = plain()
    const events = Array.from({ length: EDL_EVENT_LIMIT + 1 }, (_, i) => ({ media: 'video' as const, recIn: i, recOut: i + 1, srcIn: i, srcOut: i + 1, speed: 1 }))
    expect(() => edl({ ...plan, frames: events.length, tracks: [{ ...plan.tracks[0], events }] }, GOLDEN_EXPORT_PATHS)).toThrow()
    expect(() => edl({ ...plan, frames: EDL_EVENT_LIMIT, tracks: [{ ...plan.tracks[0], events: events.slice(0, EDL_EVENT_LIMIT) }] }, GOLDEN_EXPORT_PATHS)).not.toThrow()
  })
})

describe('§19.3: a timeline of 3,000 cuts', () => {
  it('is under 2 MB as FCPXML and quick to write', () => {
    // 3,000 clips, a third of them at 2x, over the screen, the recording's sound and the music.
    const clips = Array.from({ length: 3000 }, (_, i) => ({ id: `c${i}`, start: i * 2, end: i * 2 + 1.5, speed: i % 3 === 0 ? 2 : 1 }))
    const p = { ...goldenProject(), duration: 6001, clips, freezes: [], hasWebcam: false }
    const media = { screen: { fps: 60, frames: 360060, width: 1920, height: 1080, audio: false, video: true }, recording: { fps: 30, frames: 180030, audio: true, video: false }, music: GOLDEN_MEDIA.music }
    const plan = recordingsTimeline(p, 30, media)
    const paths = { ...GOLDEN_RECORDING_PATHS, recording: 'C:\\Videos\\Demo media\\Recording.wav' }
    const started = performance.now()
    const file = fcpxml(plan, paths, p.id)
    const ms = performance.now() - started
    expect(file.length).toBeLessThan(2 * 1024 * 1024)
    // The budget is 100 ms; the bound is generous for a test machine shared with other work.
    expect(ms).toBeLessThan(1000)
    expect(xmeml(plan, paths).length).toBeLessThan(3 * 1024 * 1024)
  })
})
