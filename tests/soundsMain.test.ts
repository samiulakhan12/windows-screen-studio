// The sound finder's main process (docs/design/sound-finder.md §4.7, §7): streams of decoded
// samples pulled chunk by chunk, owned by the window that opened them, limited, closed when idle or
// stopped; the cache file checked both ways.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: () => undefined }, ipcMain: { handle: () => undefined } }))

const { MAX_STREAMS, SoundStreams, soundDecodeArgs } = await import('../src/main/sounds/soundsIpc')
const { SOUNDS_STOPPED, SOUND_CHUNK_BYTES } = await import('../src/shared/api/sounds')
const { cacheEntry } = await import('../src/shared/audio/soundsCache')
const { SCORE_COLUMNS } = await import('../src/shared/audio/sounds')
const { ffmpegPath } = await import('../src/main/ffmpeg')

const root = mkdtempSync(path.join(tmpdir(), 'ssw-sounds-'))
const dirOf = (id: string): string => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid project id: ${id}`)
  return path.join(root, id)
}
const spawned: ChildProcess[] = []
const tracking = ((...args: Parameters<typeof spawn>) => {
  const p = spawn(...args)
  spawned.push(p)
  return p
}) as typeof spawn

/** A project with `seconds` of a 440 Hz tone as its microphone stem. */
function seed(id: string, seconds: number): string {
  const dir = dirOf(id)
  mkdirSync(dir, { recursive: true })
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}:sample_rate=48000`, '-c:a', 'aac', '-b:a', '64k', path.join(dir, 'mic.m4a')])
  return dir
}

const streams = (over: Partial<ConstructorParameters<typeof SoundStreams>[0]> = {}) => new SoundStreams({ projectDir: dirOf, ffmpeg: ffmpegPath, spawn: tracking, ...over })

async function readAll(s: InstanceType<typeof SoundStreams>, owner: number, stream: number): Promise<number[]> {
  const sizes: number[] = []
  for (;;) {
    const chunk = await s.read(owner, stream)
    if (!chunk) return sizes
    sizes.push(chunk.byteLength)
  }
}

let slow = ''
beforeAll(() => {
  slow = path.join(root, 'slow-ffmpeg.sh')
  writeFileSync(slow, '#!/bin/sh\nexec sleep 60\n')
  chmodSync(slow, 0o755)
})
afterAll(() => {
  for (const p of spawned) p.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

describe('decoding streams', () => {
  it('decodes 16 kHz mono floats, in chunks of at most 20 s, then null', async () => {
    seed('rec-a', 45)
    const s = streams()
    expect(soundDecodeArgs('x.m4a')).toEqual(['-v', 'error', '-nostdin', '-i', 'x.m4a', '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
    const info = await s.open(1, 'rec-a', 'mic')
    const st = statSync(path.join(dirOf('rec-a'), 'mic.m4a'))
    expect(info).toEqual({ stream: expect.any(Number), size: st.size, mtimeMs: st.mtimeMs })
    const sizes = await readAll(s, 1, info.stream)
    expect(sizes.slice(0, 2)).toEqual([SOUND_CHUNK_BYTES, SOUND_CHUNK_BYTES])
    expect(sizes.every((n) => n % 4 === 0)).toBe(true)
    const total = sizes.reduce((a, b) => a + b, 0) / 4 / 16000
    expect(total).toBeGreaterThan(44.9)
    expect(total).toBeLessThan(45.2)
    expect(s.openCount(1)).toBe(0)
  })

  it('checks every argument and keeps each stream to its window', async () => {
    const s = streams()
    await expect(s.open(1, '../etc', 'mic')).rejects.toThrow(/Invalid project id/)
    await expect(s.open(1, 'rec-a', 'music.mp3')).rejects.toThrow('Invalid request')
    await expect(s.open(1, 7, 'mic')).rejects.toThrow('Invalid request')
    await expect(s.open(1, 'rec-a', 'system')).rejects.toThrow(/system sound file is missing/)
    const { stream } = await s.open(1, 'rec-a', 'mic')
    await expect(s.read(2, stream)).rejects.toThrow('No such sound stream')
    s.close(2, stream)
    expect(s.openCount(1)).toBe(1)
    await expect(s.read(1, 'x')).rejects.toThrow('No such sound stream')
    s.closeOwner(1)
    expect(s.openCount(1)).toBe(0)
    await expect(s.read(1, stream)).rejects.toThrow('No such sound stream')
  })

  it('limits the streams of a window', async () => {
    const s = streams({ ffmpeg: () => slow })
    for (let i = 0; i < MAX_STREAMS; i++) await s.open(3, 'rec-a', 'mic')
    await expect(s.open(3, 'rec-a', 'mic')).rejects.toThrow(/Too many/)
    await s.open(4, 'rec-a', 'mic')
    s.stopAll()
  })

  it('rejects a waiting read when the project is stopped, and closes an idle stream', async () => {
    const s = streams({ ffmpeg: () => slow, idleMs: 200 })
    const { stream } = await s.open(1, 'rec-a', 'mic')
    const waiting = s.read(1, stream)
    await s.stop('rec-a')
    await expect(waiting).rejects.toThrow(SOUNDS_STOPPED)
    const idle = await s.open(1, 'rec-a', 'mic')
    await new Promise((r) => setTimeout(r, 400))
    await expect(s.read(1, idle.stream)).rejects.toThrow('No such sound stream')
  })

  it('reports a file ffmpeg cannot read', async () => {
    const dir = dirOf('rec-bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'mic.m4a'), 'not a sound file')
    const s = streams()
    const { stream } = await s.open(1, 'rec-bad', 'mic')
    await expect(s.read(1, stream)).rejects.toThrow(/Could not read the recording's sound/)
  })
})

describe('the cache file', () => {
  const scores = new Uint8Array(4 * SCORE_COLUMNS.length).fill(9)

  it('keeps an entry per source, and gives it back only while the file is unchanged', async () => {
    const dir = seed('rec-c', 2)
    const s = streams()
    const st = statSync(path.join(dir, 'mic.m4a'))
    expect(await s.cached('rec-c', 'mic')).toBeNull()
    const entry = cacheEntry({ size: st.size, mtimeMs: st.mtimeMs }, 'none', 4, scores)
    await s.save('rec-c', 'mic', entry)
    const file = path.join(dir, '.cache', 'sounds.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, entries: { mic: entry } })
    expect(await s.cached('rec-c', 'mic')).toEqual(entry)
    // The file changed: not given back, and a save of the old scores is refused.
    utimesSync(path.join(dir, 'mic.m4a'), new Date(), new Date(Date.now() + 5000))
    expect(await s.cached('rec-c', 'mic')).toBeNull()
    await expect(s.save('rec-c', 'mic', entry)).rejects.toThrow(/changed/)
  })

  it('refuses malformed entries and ignores a malformed file', async () => {
    const dir = seed('rec-d', 2)
    const s = streams()
    const st = statSync(path.join(dir, 'mic.m4a'))
    const entry = cacheEntry({ size: st.size, mtimeMs: st.mtimeMs }, 'none', 4, scores)
    await expect(s.save('rec-d', 'mic', { ...entry, n: 5 })).rejects.toThrow('Invalid sound scores')
    await expect(s.save('rec-d', 'mic', 'x')).rejects.toThrow('Invalid sound scores')
    await expect(s.save('rec-d', 'screen.mp4', entry)).rejects.toThrow('Invalid request')
    mkdirSync(path.join(dir, '.cache'), { recursive: true })
    writeFileSync(path.join(dir, '.cache', 'sounds.json'), '{"version":1,"entries":{"mic":{"size":1}}}')
    expect(await s.cached('rec-d', 'mic')).toBeNull()
    writeFileSync(path.join(dir, '.cache', 'sounds.json'), 'not json')
    expect(await s.cached('rec-d', 'mic')).toBeNull()
    // A broken file is replaced by a good one on the next save.
    await s.save('rec-d', 'mic', entry)
    expect(await s.cached('rec-d', 'mic')).toEqual(entry)
  })

  it('writes nothing for a project stopped meanwhile', async () => {
    const dir = seed('rec-e', 2)
    const s = streams()
    const st = statSync(path.join(dir, 'mic.m4a'))
    const saving = s.save('rec-e', 'mic', cacheEntry({ size: st.size, mtimeMs: st.mtimeMs }, 'none', 4, scores))
    await s.stop('rec-e')
    await saving
    expect(existsSync(path.join(dir, '.cache', 'sounds.json'))).toBe(false)
  })
})
