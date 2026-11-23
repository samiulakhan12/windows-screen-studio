/**
 * The look pass kept in the project (docs/design/auto-blur.md §5.2): `<project>/.cache/look.bin`,
 * keyed by screen.mp4's size and modified time, the look scale and the step, like the scene scan's
 * scenes.json. Find again, Follow and Cover this text everywhere read it instead of decoding the
 * recording again. It holds tile bits and moves: no pixels, no text. Read strictly: anything that does
 * not parse as the helper's look frames, or belongs to another file, is ignored.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { addLookFrames, emptyLook, type LookData } from '../../shared/privacy/look'
import { parseHelperEvent } from '../../shared/privacy/protocol'

export interface LookKey {
  /** screen.mp4's size in bytes and modified time (whole milliseconds). */
  size: number
  mtimeMs: number
  k: number
  step: number
}

export const LOOK_CACHE_DIR = '.cache'
export const LOOK_FILE = 'look.bin'
const VERSION = 1
/** Largest look data read back (a 4-hour recording at 30 analysed frames a second). */
const MAX_BYTES = 256 * 1024 * 1024

const zip = promisify(gzip)
const unzip = promisify(gunzip)

const sameKey = (a: LookKey, b: LookKey): boolean => a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs) && a.k === b.k && a.step === b.step

/** The look data kept for `key`, or null (none, another file's, or unreadable). */
export async function readLookCache(projectDir: string, key: LookKey): Promise<LookData | null> {
  try {
    const packed = await fs.readFile(path.join(projectDir, LOOK_CACHE_DIR, LOOK_FILE))
    const text = (await unzip(packed, { maxOutputLength: MAX_BYTES })).toString('utf8')
    const raw = JSON.parse(text) as { v?: unknown; key?: LookKey; fps?: unknown; width?: unknown; height?: unknown; frames?: unknown }
    if (raw.v !== VERSION || !raw.key || typeof raw.key !== 'object' || !sameKey(raw.key, key)) return null
    const fps = raw.fps
    const width = raw.width
    const height = raw.height
    if (typeof fps !== 'number' || !(fps > 0) || typeof width !== 'number' || typeof height !== 'number' || !(width > 0 && height > 0)) return null
    // The frames as the helper sends them, read by the protocol's strict reader.
    const event = parseHelperEvent(JSON.stringify({ id: 0, look: raw.frames, done: true }))
    if (!event || !('look' in event)) return null
    const data = emptyLook({ width, height }, fps)
    if (data.k !== key.k || data.step !== key.step) return null
    addLookFrames(data, event.look)
    return data
  } catch {
    return null
  }
}

/** Keeps `data` for `key` (written whole, then renamed into place). */
export async function writeLookCache(projectDir: string, key: LookKey, data: LookData): Promise<void> {
  const dir = path.join(projectDir, LOOK_CACHE_DIR)
  await fs.mkdir(dir, { recursive: true })
  const body = await zip(Buffer.from(JSON.stringify({ v: VERSION, key: { size: key.size, mtimeMs: Math.round(key.mtimeMs), k: key.k, step: key.step }, fps: data.fps, width: data.size.width, height: data.size.height, frames: data.frames }), 'utf8'))
  const file = path.join(dir, LOOK_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, body)
  await fs.rename(tmp, file)
}

/** The key of a project's screen.mp4 at look scale `k` and step `step`, or null when the file is missing. */
export async function lookKeyOf(projectDir: string, k: number, step: number): Promise<LookKey | null> {
  try {
    const st = await fs.stat(path.join(projectDir, 'screen.mp4'))
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs), k, step }
  } catch {
    return null
  }
}
