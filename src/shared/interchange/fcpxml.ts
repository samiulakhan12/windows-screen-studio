/**
 * FCPXML 1.10 for DaVinci Resolve and Final Cut Pro (docs/design/output-and-languages.md §8.3), one
 * plain `.fcpxml` file in UTF-8. Pure.
 *
 * - The first video track is the spine: its events are asset-clips, a dissolve is a Cross Dissolve
 *   transition in the spine starting at the cut (Flown's crossfade runs from the cut on), a hole in
 *   the track a gap. Every other track is connected to the spine element under its first frame, on
 *   its own lane (video above, sound below) with its role; a turned-off track's clips carry
 *   `enabled="0"`. With `pictureOnly` the spine's clips play their picture only (`srcEnable`).
 * - A speed is a two-point linear timeMap over the clip, a hold one whose values are equal. A clip at
 *   normal speed starts at its source frame; a retimed clip's own timeline is the sequence's, so the
 *   clips and markers anchored to it sit at their sequence time.
 * - Times are rationals of whole frames (`{frames}/{fps}s`), source times on each source's own grid,
 *   never decimals. Names go through xmlAttr and paths through fileUrl, so no name can break the file.
 * - Asset uids are `flown.{projectId}.{n}`, n a number made from the file's path: importing the same
 *   export twice is recognised, and two exports of one project never share a uid.
 */
import { fileUrl, xmlAttr } from './fileUrl'
import type { TimelineEvent, TimelineMedia, TimelinePlan, TimelineSource } from './timelinePlan'

/** Final Cut Pro's own Cross Dissolve. */
const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'

/** A non-negative rational number of seconds. */
interface Time {
  n: number
  d: number
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
/** `a + b` over the least common multiple of their denominators, so a sum stays on the frame grids it came from. */
function add(a: Time, b: Time): Time {
  const d = (a.d / gcd(a.d, b.d)) * b.d
  return { n: a.n * (d / a.d) + b.n * (d / b.d), d }
}
const show = (t: Time): string => (t.n === 0 ? '0s' : `${t.n}/${t.d}s`)

/** A frame rate as a fraction: whole rates as they are, NTSC rates (29.97 …) over 1001, anything else in thousandths. */
export function rateFraction(fps: number): { num: number; den: number } {
  const whole = Math.round(fps)
  if (Math.abs(whole - fps) < 1e-6) return { num: whole, den: 1 }
  const ntsc = Math.round(fps * 1.001) * 1000
  if (Math.abs(ntsc / 1001 - fps) < 1e-4) return { num: ntsc, den: 1001 }
  return { num: Math.round(fps * 1000), den: 1000 }
}

/** `frames` of a source at `fps`, in seconds. */
function srcTime(frames: number, fps: number): Time {
  const r = rateFraction(fps)
  return { n: frames * r.den, d: r.num }
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
const stemOf = (path: string): string => baseName(path).replace(/\.[^.]*$/, '')

/** A 32-bit FNV-1a hash of `text`: the same path always gives the same number. */
function pathNumber(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

type Attr = [string, string | number | undefined]
const attrs = (pairs: readonly Attr[]): string =>
  pairs
    .filter((p): p is [string, string | number] => p[1] !== undefined)
    .map(([k, v]) => ` ${k}="${typeof v === 'number' ? v : xmlAttr(v)}"`)
    .join('')

/** An element of the spine, with where its own timeline starts and what is anchored to it. */
interface SpineItem {
  recIn: number
  recOut: number
  /** Its local time at recIn. */
  start: Time
  /** Its opening lines (the tag and the timeMap). */
  open: string[]
  close: string
  anchored: string[]
  markers: string[]
  transition?: string
}

/** The FCPXML of `plan`; uids are 'flown.{projectId}.{n}'. `paths` names the file of every media the plan uses. */
export function fcpxml(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>, projectId: string): string {
  const fps = plan.fps
  const T = (frames: number): Time => ({ n: frames, d: fps })
  const at = (frames: number): string => show(T(frames))
  const pathOf = (m: TimelineMedia): string => {
    const p = paths[m]
    if (!p) throw new Error(`No file for ${m}`)
    return p
  }
  const sourceOf = (m: TimelineMedia): TimelineSource => {
    const s = plan.media[m]
    if (!s) throw new Error(`No facts for ${m}`)
    return s
  }

  // Formats: one per distinct size and rate, the sequence's first.
  const formats: { id: string; key: string; line: string }[] = []
  const formatFor = (width: number, height: number, rate: number): string => {
    const key = `${width}x${height}@${rate}`
    const found = formats.find((f) => f.key === key)
    if (found) return found.id
    const id = `r${formats.length + 1}`
    const r = rateFraction(rate)
    formats.push({ id, key, line: `<format${attrs([['id', id], ['frameDuration', show({ n: r.den, d: r.num })], ['width', width], ['height', height]])}/>` })
    return id
  }
  const sequenceFormat = formatFor(plan.width, plan.height, fps)

  // Assets, in the order the tracks first use them.
  const order: TimelineMedia[] = []
  for (const track of plan.tracks) for (const e of track.events) if (!order.includes(e.media)) order.push(e.media)
  const assetFormats = order.map((m) => {
    const s = sourceOf(m)
    return s.video ? formatFor(s.width ?? plan.width, s.height ?? plan.height, s.fps) : undefined
  })
  const dissolves = plan.tracks.some((t) => t.events.some((e) => !!e.dissolve))
  const effectId = `r${formats.length + 1}`
  const firstAsset = formats.length + (dissolves ? 2 : 1)
  const assetId = (m: TimelineMedia): string => `r${firstAsset + order.indexOf(m)}`
  const assets = order.map((m, i) => {
    const s = sourceOf(m)
    const path = pathOf(m)
    return [
      `<asset${attrs([
        ['id', assetId(m)],
        ['name', stemOf(path)],
        ['uid', `flown.${projectId}.${pathNumber(path)}`],
        ['start', '0s'],
        ['duration', show(srcTime(s.frames, s.fps))],
        ['hasVideo', s.video ? '1' : '0'],
        ['format', assetFormats[i]],
        ['hasAudio', s.audio ? '1' : '0'],
        ['audioSources', s.audio ? '1' : undefined],
        ['audioChannels', s.audio ? '2' : undefined],
        ['audioRate', s.audio ? '48000' : undefined]
      ])}>`,
      `  <media-rep${attrs([['kind', 'original-media'], ['src', fileUrl(path, 'fcpxml')]])}/>`,
      '</asset>'
    ].join('\n')
  })

  /** A clip's local time at its first frame: the source's in point at normal speed, else the sequence time (its timeMap's own timeline). */
  const localStart = (e: TimelineEvent): Time => (e.speed === 1 ? srcTime(e.srcIn, sourceOf(e.media).fps) : T(e.recIn))

  /** The opening lines of the clip of `e`: its tag, its timeMap when retimed, its level when it has one. */
  const clipOpen = (e: TimelineEvent, offset: Time, more: { lane?: number; enabled?: boolean; srcEnable?: 'video'; audioRole?: string }): string[] => {
    const lines = [
      `<asset-clip${attrs([
        ['ref', assetId(e.media)],
        ['lane', more.lane],
        ['offset', show(offset)],
        ['name', stemOf(pathOf(e.media))],
        ['start', show(localStart(e))],
        ['duration', at(e.recOut - e.recIn)],
        ['enabled', more.enabled === false ? '0' : undefined],
        ['srcEnable', more.srcEnable],
        ['audioRole', more.audioRole]
      ])}>`
    ]
    if (e.speed !== 1) {
      const s = sourceOf(e.media)
      const from = show(srcTime(e.srcIn, s.fps))
      const to = e.speed === 0 ? from : show(srcTime(e.srcOut, s.fps))
      lines.push(`  <timeMap><timept time="${at(e.recIn)}" value="${from}" interp="linear"/><timept time="${at(e.recOut)}" value="${to}" interp="linear"/></timeMap>`)
    }
    if (e.gainDb !== undefined) lines.push(`  <adjust-volume amount="${Number(e.gainDb.toFixed(2))}dB"/>`)
    return lines
  }

  // The spine: the first video track's events, with gaps where it has none.
  const v1 = plan.tracks.find((t) => t.kind === 'video')
  const spine: SpineItem[] = []
  let cursor = 0
  const gap = (from: number, to: number): void => {
    spine.push({
      recIn: from,
      recOut: to,
      start: T(from),
      open: [`<gap${attrs([['name', 'Gap'], ['offset', at(from)], ['start', at(from)], ['duration', at(to - from)]])}>`],
      close: '</gap>',
      anchored: [],
      markers: []
    })
  }
  for (const e of v1?.events ?? []) {
    if (e.recIn > cursor) gap(cursor, e.recIn)
    const prev = spine[spine.length - 1]
    spine.push({
      recIn: e.recIn,
      recOut: e.recOut,
      start: localStart(e),
      open: clipOpen(e, T(e.recIn), { enabled: v1!.enabled, srcEnable: plan.pictureOnly ? 'video' : undefined }),
      close: '</asset-clip>',
      anchored: [],
      markers: [],
      transition:
        e.dissolve && prev && prev.recOut === e.recIn
          ? [`<transition${attrs([['name', 'Cross Dissolve'], ['offset', at(e.recIn)], ['duration', at(e.dissolve)]])}>`, `  <filter-video ref="${effectId}" name="Cross Dissolve"/>`, '</transition>'].join('\n')
          : undefined
    })
    cursor = e.recOut
  }
  if (cursor < plan.frames) gap(cursor, plan.frames)

  /** The spine element under `frame`. */
  const parentAt = (frame: number): SpineItem => {
    let lo = 0
    let hi = spine.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (spine[mid].recIn <= frame) lo = mid
      else hi = mid - 1
    }
    return spine[lo]
  }
  const localAt = (parent: SpineItem, frame: number): Time => add(parent.start, T(frame - parent.recIn))

  // Every other track, connected: video above the spine, sound below, one lane each.
  let up = 0
  let down = 0
  for (const track of plan.tracks) {
    if (track === v1) continue
    const lane = track.kind === 'video' ? ++up : -++down
    for (const e of track.events) {
      const parent = parentAt(e.recIn)
      const lines = clipOpen(e, localAt(parent, e.recIn), { lane, enabled: track.enabled, audioRole: track.kind === 'audio' ? (track.role ?? 'dialogue') : undefined })
      parent.anchored.push(lines.length === 1 ? lines[0].replace(/>$/, '/>') : [...lines, '</asset-clip>'].join('\n'))
    }
  }

  for (const m of plan.markers) {
    const frame = Math.max(0, Math.min(m.frame, plan.frames - 1))
    const parent = parentAt(frame)
    const start = show(localAt(parent, Math.min(frame, parent.recOut - 1)))
    parent.markers.push(
      m.chapter
        ? `<chapter-marker${attrs([['start', start], ['duration', at(1)], ['value', m.name], ['posterOffset', '0s']])}/>`
        : `<marker${attrs([['start', start], ['duration', at(1)], ['value', m.name]])}/>`
    )
  }

  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE fcpxml>', '<fcpxml version="1.10">']
  const push = (indent: number, text: string): void => {
    for (const line of text.split('\n')) out.push(' '.repeat(indent) + line)
  }
  push(2, '<resources>')
  for (const f of formats) push(4, f.line)
  if (dissolves) push(4, `<effect${attrs([['id', effectId], ['name', 'Cross Dissolve'], ['uid', CROSS_DISSOLVE_UID]])}/>`)
  for (const a of assets) push(4, a)
  push(2, '</resources>')
  push(2, '<library>')
  push(4, '<event name="Flown">')
  push(6, `<project${attrs([['name', plan.name]])}>`)
  push(8, `<sequence${attrs([['format', sequenceFormat], ['duration', at(plan.frames)], ['tcStart', '0s'], ['tcFormat', 'NDF'], ['audioLayout', 'stereo'], ['audioRate', '48k']])}>`)
  push(10, '<spine>')
  for (const item of spine) {
    if (item.transition) push(12, item.transition)
    if (item.open.length === 1 && !item.anchored.length && !item.markers.length) {
      push(12, item.open[0].replace(/>$/, '/>'))
      continue
    }
    push(12, item.open.join('\n'))
    for (const a of item.anchored) push(14, a)
    for (const m of item.markers) push(14, m)
    push(12, item.close)
  }
  push(10, '</spine>')
  push(8, '</sequence>')
  push(6, '</project>')
  push(4, '</event>')
  push(2, '</library>')
  out.push('</fcpxml>', '')
  return out.join('\n')
}
