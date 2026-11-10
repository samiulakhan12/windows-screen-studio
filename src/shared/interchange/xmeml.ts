/**
 * Premiere XML (xmeml version 4, FCP 7's interchange format) for Premiere Pro, which imports it
 * natively and does not read FCPXML; DaVinci Resolve reads it too (docs/design/output-and-languages.md
 * §8.4). Pure.
 *
 * - The sequence runs at the plan's whole rate (`ntsc FALSE`) from 00:00:00:00, in the plan's frame
 *   size, so V1 fills it without a transform.
 * - Each track's events are clip items: `start` and `end` in sequence frames, `in` and `out` in the
 *   source's own frames, the file written in full once and referred to by id after. A turned-off
 *   track's clip items carry `<enabled>FALSE</enabled>`.
 * - The first video track's own sound is a linked clip item on its own audio track, left out when the
 *   plan is picture only (stems written alongside it).
 * - A speed is the Time Remap filter (speed in percent), a hold speed 0 without frame blending; a
 *   dissolve a Cross Dissolve transition item from the cut; a level the Audio Levels filter (linear).
 *   Markers sit on the sequence.
 */
import { fileUrl, xmlText } from './fileUrl'
import { t } from '../i18n/t'
import type { TimelineEvent, TimelineMedia, TimelinePlan, TimelineSource } from './timelinePlan'

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The rate element of a frame rate: NTSC rates (29.97 …) as their whole timebase with `ntsc TRUE`. */
function rate(fps: number): string {
  const whole = Math.round(fps)
  const ntsc = Math.abs(whole - fps) >= 1e-6 && Math.abs((Math.round(fps * 1.001) * 1000) / 1001 - fps) < 1e-4
  return `<rate><timebase>${ntsc ? Math.round(fps * 1.001) : Math.max(1, whole)}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`
}

/** A percentage or a level without float noise (150, 33.3333, 0.707946). */
const num = (v: number, digits: number): string => String(Number(v.toFixed(digits)))

interface Item {
  id: string
  track: number
  index: number
  kind: 'video' | 'audio'
}

/** The Premiere XML of `plan`. `paths` names the file of every media the plan uses. */
export function xmeml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string {
  const pathOf = (m: TimelineMedia): string => {
    const p = paths[m]
    if (!p) throw new Error(t('errors.timeline.invalid'))
    return p
  }
  const sourceOf = (m: TimelineMedia): TimelineSource => {
    const s = plan.media[m]
    if (!s) throw new Error(t('errors.timeline.invalid'))
    return s
  }
  const seqRate = rate(plan.fps)

  // Files: written in full where first used, by id after.
  const fileIds = new Map<TimelineMedia, string>()
  const fileLines = (m: TimelineMedia): string[] => {
    const known = fileIds.get(m)
    if (known) return [`<file id="${known}"/>`]
    const id = `file-${fileIds.size + 1}`
    fileIds.set(m, id)
    const s = sourceOf(m)
    const path = pathOf(m)
    const media: string[] = []
    if (s.video) media.push(`  <video><samplecharacteristics>${rate(s.fps)}<width>${s.width ?? plan.width}</width><height>${s.height ?? plan.height}</height></samplecharacteristics></video>`)
    if (s.audio) media.push('  <audio><samplecharacteristics><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>')
    return [
      `<file id="${id}">`,
      `  <name>${xmlText(baseName(path))}</name>`,
      `  <pathurl>${xmlText(fileUrl(path, 'xmeml'))}</pathurl>`,
      `  ${rate(s.fps)}`,
      `  <duration>${s.frames}</duration>`,
      '  <media>',
      ...media.map((l) => `  ${l}`),
      '  </media>',
      '</file>'
    ]
  }

  const filters = (e: TimelineEvent, kind: 'video' | 'audio'): string[] => {
    const out: string[] = []
    if (e.speed !== 1) {
      out.push(
        '<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>' +
          '<parameter><parameterid>variablespeed</parameterid><value>0</value></parameter>' +
          `<parameter><parameterid>speed</parameterid><value>${num(e.speed * 100, 4)}</value></parameter>` +
          '<parameter><parameterid>reverse</parameterid><value>FALSE</value></parameter>' +
          '<parameter><parameterid>frameblending</parameterid><value>FALSE</value></parameter></effect></filter>'
      )
    }
    if (kind === 'audio' && e.gainDb !== undefined) {
      out.push(
        '<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>' +
          `<parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${num(Math.pow(10, e.gainDb / 20), 6)}</value></parameter></effect></filter>`
      )
    }
    return out
  }

  let nextItem = 0
  const newItem = (track: number, index: number, kind: 'video' | 'audio'): Item => ({ id: `clipitem-${++nextItem}`, track, index, kind })

  /**
   * One clip item. It is written on one line (a long timeline stays small: 3,000 cuts in under 2 MB,
   * §19.3) unless it carries a file's first, full description.
   */
  const clipItem = (e: TimelineEvent, item: Item, enabled: boolean, links: readonly Item[]): string[] => {
    const s = sourceOf(e.media)
    const path = pathOf(e.media)
    const head =
      `<clipitem id="${item.id}"><name>${xmlText(baseName(path))}</name>${enabled ? '' : '<enabled>FALSE</enabled>'}<duration>${s.frames}</duration>${rate(s.fps)}` +
      `<start>${e.recIn}</start><end>${e.recOut}</end><in>${e.srcIn}</in><out>${e.srcOut}</out>`
    const tail = [
      ...(item.kind === 'audio' ? ['<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>'] : []),
      ...filters(e, item.kind),
      ...links.map(
        (l) => `<link><linkclipref>${l.id}</linkclipref><mediatype>${l.kind}</mediatype><trackindex>${l.track}</trackindex><clipindex>${l.index}</clipindex>${l.kind === 'audio' ? '<groupindex>1</groupindex>' : ''}</link>`
      ),
      '</clipitem>'
    ].join('')
    const file = fileLines(e.media)
    if (file.length === 1) return [head + file[0] + tail]
    return [head, ...file.map((l) => `  ${l}`), tail]
  }

  const dissolve = (e: TimelineEvent): string[] => [
    '<transitionitem>',
    `  <start>${e.recIn}</start>`,
    `  <end>${e.recIn + e.dissolve!}</end>`,
    '  <alignment>start</alignment>',
    `  ${seqRate}`,
    '  <effect>',
    '    <name>Cross Dissolve</name>',
    '    <effectid>Cross Dissolve</effectid>',
    '    <effectcategory>Dissolve</effectcategory>',
    '    <effecttype>transition</effecttype>',
    '    <mediatype>video</mediatype>',
    '  </effect>',
    '</transitionitem>'
  ]

  const videoTracks = plan.tracks.filter((t) => t.kind === 'video')
  const audioTracks = plan.tracks.filter((t) => t.kind === 'audio')
  const v1 = videoTracks[0]
  // V1's own sound, linked to its picture, unless stems carry the sound.
  const ownSound = !!v1 && !plan.pictureOnly && v1.events.some((e) => sourceOf(e.media).audio)

  const video: string[][] = []
  const audio: string[][] = []
  const v1Items = new Map<TimelineEvent, Item>()
  const soundItems = new Map<TimelineEvent, Item>()
  if (v1 && ownSound) {
    let k = 0
    for (const e of v1.events) {
      v1Items.set(e, newItem(1, v1Items.size + 1, 'video'))
      if (sourceOf(e.media).audio) soundItems.set(e, newItem(1, ++k, 'audio'))
    }
  }

  videoTracks.forEach((track, t) => {
    const lines: string[] = []
    let prevOut = -1
    track.events.forEach((e, i) => {
      if (e.dissolve && prevOut === e.recIn) lines.push(...dissolve(e))
      const item = v1Items.get(e) ?? newItem(t + 1, i + 1, 'video')
      const sound = soundItems.get(e)
      lines.push(...clipItem(e, item, track.enabled, sound ? [item, sound] : []))
      prevOut = e.recOut
    })
    video.push(lines)
  })
  if (v1 && ownSound) {
    const lines: string[] = []
    for (const e of v1.events) {
      const sound = soundItems.get(e)
      if (sound) lines.push(...clipItem(e, sound, v1.enabled, [v1Items.get(e)!, sound]))
    }
    audio.push(lines)
  }
  audioTracks.forEach((track, t) => {
    const lines: string[] = []
    track.events.forEach((e, i) => lines.push(...clipItem(e, newItem(t + 1 + (ownSound ? 1 : 0), i + 1, 'audio'), track.enabled, [])))
    audio.push(lines)
  })

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${xmlText(plan.name)}</name>`,
    `    <duration>${plan.frames}</duration>`,
    `    ${seqRate}`,
    `    <timecode>${seqRate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    '    <media>',
    '      <video>',
    `        <format><samplecharacteristics>${seqRate}<width>${plan.width}</width><height>${plan.height}</height><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic><fielddominance>none</fielddominance></samplecharacteristics></format>`
  ]
  const tracks = (list: string[][]): void => {
    for (const lines of list) {
      if (!lines.length) {
        out.push('        <track/>')
        continue
      }
      out.push('        <track>', ...lines.map((l) => `          ${l}`), '        </track>')
    }
  }
  tracks(video)
  out.push('      </video>', '      <audio>', '        <numOutputChannels>2</numOutputChannels>', '        <format><samplecharacteristics><samplerate>48000</samplerate></samplecharacteristics></format>')
  tracks(audio)
  out.push('      </audio>', '    </media>')
  for (const m of plan.markers) out.push(`    <marker><name>${xmlText(m.name)}</name><comment></comment><in>${m.frame}</in><out>-1</out></marker>`)
  out.push('  </sequence>', '</xmeml>', '')
  return out.join('\n')
}
