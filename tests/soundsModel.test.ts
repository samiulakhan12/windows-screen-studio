// The bundled YAMNet model (docs/design/sound-finder.md §4.1): its pin, and every class index the
// finder uses names the label it means, read from the label list packed inside the model.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SOUND_KINDS, SOUND_MODEL, SPEECH_CLASSES, type SoundKind } from '../src/shared/audio/sounds'

const MODEL = path.join(__dirname, '..', 'resources', 'sounds', SOUND_MODEL.file)

/** The files of the zip appended to a TFLite model (its metadata's associated files). */
function zipFiles(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('no zip in the model')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  // Offsets in the zip are relative to its own start, which is where the central directory says it is minus its size.
  const cdStart = eocd - cdSize
  const zipStart = cdStart - buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  let p = cdStart
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = zipStart + buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(data, data + size)
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('the bundled sound model', () => {
  const buf = readFileSync(MODEL)

  it('is the pinned YAMNet file', () => {
    expect(buf.length).toBe(SOUND_MODEL.bytes)
    expect(createHash('sha256').update(buf).digest('hex')).toBe(SOUND_MODEL.sha256)
  })

  it('names every class the finder listens for as the label it means', () => {
    const labels = zipFiles(buf).get('yamnet_label_list.txt')!.toString('utf8').trim().split('\n')
    expect(labels.length).toBe(SOUND_MODEL.classes)
    const want: Record<SoundKind | 'speech', string[]> = {
      speech: ['Speech', 'Child speech, kid speaking', 'Conversation', 'Narration, monologue', 'Speech synthesizer'],
      cough: ['Cough', 'Throat clearing'],
      sneeze: ['Sneeze'],
      typing: ['Typing', 'Typewriter', 'Computer keyboard'],
      ping: ['Bell', 'Chime', 'Beep, bleep', 'Ping', 'Ding'],
      phone: ['Buzz', 'Telephone', 'Telephone bell ringing', 'Ringtone', 'Vibration'],
      dog: ['Dog', 'Bark', 'Yip', 'Howl', 'Bow-wow', 'Growling', 'Whimper (dog)'],
      door: ['Door', 'Doorbell', 'Ding-dong', 'Slam', 'Knock'],
      music: ['Music']
    }
    expect(SPEECH_CLASSES.map((i) => labels[i])).toEqual(want.speech)
    for (const [kind, spec] of Object.entries(SOUND_KINDS)) expect(spec.classes.map((i) => labels[i]), kind).toEqual(want[kind as SoundKind])
  })
})
