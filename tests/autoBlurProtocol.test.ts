import { describe, expect, it } from 'vitest'
import { MAX_LINE, commandLine, parseHelperCommand, parseHelperEvent, type HelperCommand, type HelperEvent } from '../src/shared/privacy/protocol'

/*
 * The text reader helper's protocol (docs/design/auto-blur.md §16.0, §17.1 test 33): main reads every
 * line the helper writes strictly, and every command round-trips.
 */

const line = { box: [10, 20, 300, 18], quad: [[10, 20], [310, 20], [310, 38], [10, 38]], variants: [{ model: 'tiny', text: 'jane@example.com', conf: 0.97, spans: [[10, 20], [20, 30]] }], ring: '#1c1c22', spread: 3 }
const EVENTS: HelperEvent[] = [
  { alive: 3 },
  { id: 1, opened: { protocol: 1, version: '0.1.0', reader: 'paddle' } },
  { id: 2, look: [{ t: 0.5, key: true, tiles: '0101', moves: [{ box: [0, 0, 100, 100], dx: 0, dy: -30, score: 0.9, alt: [[0, -28, 0.7]] }] }], done: false },
  { id: 3, read: { t: 1.25, lines: [line as never], qr: [{ quad: [[0, 0], [1, 0], [1, 1], [0, 1]], payload: null }] } },
  { id: 3, read: { t: 1.25, lines: [], qr: [], partial: [[0, 0, 64, 64]] } },
  { id: 4, careful: [[{ model: 'small', text: 'x', conf: 0.5, spans: [[0, 1]] }]] },
  { id: 5, session: { from: 1, to: 9, frames: 480 } },
  { id: 6, matched: [{ track: 0, parts: [0.9, null], best: { dx: 0, dy: -30, scale: 1 }, second: 0.2 }] },
  { id: 7, done: true },
  { id: 8, error: 'tooLarge' }
]
const COMMANDS: HelperCommand[] = [
  { op: 'open', id: 1, protocol: 1, reader: 'paddle', models: [{ file: 'PP-OCRv6_tiny_det_onnx/inference.onnx', path: 'C:\\m\\det.onnx', bytes: 1780590, sha256: 'a'.repeat(64) }], ffmpeg: 'C:\\ffmpeg.exe' },
  { op: 'look', id: 2, video: 'C:\\p\\screen.mp4', k: 0.25, step: 2, from: 0, to: 60 },
  { op: 'read', id: 3, video: 'C:\\p\\screen.mp4', key: 1, t: 1.25, areas: [[0, 0, 1920, 1088]] },
  { op: 'careful', id: 4, read: 3, lines: [0, 2] },
  { op: 'release', id: 5, read: 3 },
  { op: 'followOpen', id: 6, video: 'C:\\p\\screen.mp4', key: 0, from: 1, to: 9, dir: -1 },
  { op: 'track', id: 7, session: 6, track: 0, t: 1, parts: [[1, 2, 3, 4]] },
  { op: 'match', id: 8, session: 6, t: 1.033, tracks: [{ track: 0, parts: [0], candidates: [{ dx: 0, dy: -2, scale: 1 }] }] },
  { op: 'closeSession', id: 9, session: 6 },
  { op: 'cancel', id: 10, target: 3 },
  { op: 'pause', id: 11 },
  { op: 'resume', id: 12 },
  { op: 'stop', id: 13 }
]

describe('auto-blur contracts: the helper protocol', () => {
  it('33. parseHelperEvent is strict: unknown keys, wrong types and lines over 16 MB give null; commandLine and parsing round-trip every command', () => {
    for (const e of EVENTS) expect(parseHelperEvent(JSON.stringify(e)), JSON.stringify(e)).toEqual(e)
    const bad = [
      '',
      'not json',
      '[]',
      'null',
      '{"alive":-1}',
      '{"alive":1,"x":1}',
      '{"id":1}',
      '{"id":"1","done":true}',
      '{"id":1.5,"done":true}',
      '{"id":1,"done":false}',
      '{"id":1,"error":"other"}',
      '{"id":1,"error":"model","extra":1}',
      '{"id":1,"opened":{"protocol":1,"version":"x","reader":"cloud"}}',
      '{"id":1,"look":[{"t":0,"key":true,"tiles":"","moves":[{"box":[0,0,1],"dx":0,"dy":0,"score":1,"alt":[]}]}],"done":true}',
      '{"id":1,"read":{"t":0,"lines":[{"box":[0,0,1,1],"quad":[],"variants":[{"model":"big","text":"","conf":1,"spans":[]}],"ring":"#000000","spread":0}],"qr":[]}}',
      '{"id":1,"read":{"t":0,"lines":[],"qr":[],"partial":[[0,0,1,1]],"text":"leak"}}',
      '{"id":1,"read":{"t":"0","lines":[],"qr":[]}}',
      '{"id":1,"read":{"t":0,"lines":[{"box":[0,0,1,1],"quad":[],"variants":[],"ring":"red","spread":0}],"qr":[]}}',
      '{"id":1,"careful":[["x"]]}',
      '{"id":1,"session":{"from":0,"to":1}}',
      '{"id":1,"matched":[{"track":0,"parts":["a"],"best":null,"second":0}]}',
      '{"__proto__":{"alive":1},"alive":1}',
      `{"id":1,"done":true${' '.repeat(MAX_LINE)}}`
    ]
    for (const b of bad) expect(parseHelperEvent(b), b.slice(0, 80)).toBeNull()
    expect(() => parseHelperEvent(undefined as unknown as string)).not.toThrow()
    for (const c of COMMANDS) {
      const text = commandLine(c)
      expect(text).not.toContain('\n')
      expect(parseHelperCommand(text)).toEqual(c)
    }
    expect(parseHelperCommand('{"op":"open","id":1,"protocol":2,"reader":"paddle","models":[],"ffmpeg":"f"}')).toBeNull()
    expect(parseHelperCommand('{"op":"read","id":1,"video":"v","key":0,"t":0,"areas":[],"extra":1}')).toBeNull()
    expect(parseHelperCommand('{"op":"readImage","id":1,"png":"x"}')).toBeNull()
  })
})
