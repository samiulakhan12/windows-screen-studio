import { trackEnd } from '../../../shared/editor/mediaLength'
import { demuxVideoTrack } from '../../../shared/render/mp4'

/** First read: covers the header and, for the app's faststart proxies, usually the start of `moov`. */
const HEAD_BYTES = 64 * 1024

/**
 * Length of the video track of an MP4 served with Range support (the project media
 * protocol), as opposed to the container duration a <video> element reports, which
 * also covers a longer audio track. Reads only the file's metadata. Resolves to null
 * (never rejects) when it cannot be determined.
 */
export async function videoTrackDuration(url: string, timeoutMs = 10000): Promise<number | null> {
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), timeoutMs)
  const get = async (start: number, end: number): Promise<Response> => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: abort.signal })
    if (res.status !== 206) throw new Error(`ranged read failed (${res.status})`)
    return res
  }
  try {
    const first = await get(0, HEAD_BYTES)
    const size = Number(/\/(\d+)\s*$/.exec(first.headers.get('Content-Range') ?? '')?.[1])
    const head = new Uint8Array(await first.arrayBuffer())
    if (!Number.isFinite(size) || size <= 0) throw new Error('unknown file size')
    const read = async (offset: number, length: number): Promise<Uint8Array> =>
      offset + length <= head.length ? head.subarray(offset, offset + length) : new Uint8Array(await (await get(offset, offset + length)).arrayBuffer())
    return trackEnd((await demuxVideoTrack(read, size)).samples)
  } catch (err) {
    console.warn('Could not read the video track length; using the container duration:', err)
    return null
  } finally {
    window.clearTimeout(timer)
  }
}
