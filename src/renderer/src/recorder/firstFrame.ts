import { epochNow } from '../../../shared/recording/epochClock'

export { epochNow, syncEpoch } from '../../../shared/recording/epochClock'

interface FrameReader {
  read(): Promise<{ value?: { close(): void; displayWidth?: number; displayHeight?: number }; done: boolean }>
  cancel(): Promise<void>
}

type ProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: { getReader(): FrameReader } }

/**
 * Epoch time at which the next frame of `track` arrives, or null if that cannot be
 * measured. Used to line the camera's timeline up with the screen's: each recorder's
 * timeline starts at its own first frame. A clone is read so the recorded track is
 * never affected.
 */
export async function nextFrameTime(track: MediaStreamTrack, timeoutMs = 3000): Promise<number | null> {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor
  if (!Processor || track.readyState !== 'live') return null
  const clone = track.clone()
  let reader: FrameReader | null = null
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  try {
    reader = new Processor({ track: clone }).readable.getReader()
    const frame = reader.read().then((r) => {
      const at = epochNow()
      r.value?.close()
      return r.done ? null : at
    })
    return await Promise.race([frame, timeout])
  } catch {
    return null
  } finally {
    void reader?.cancel().catch(() => undefined)
    clone.stop()
  }
}

/**
 * Size of the next frame of `track`, or null if it cannot be read in time. Right after
 * getDisplayMedia() a window track's settings can still report a default size (e.g. the
 * screen's) instead of the window's: the first frame tells the truth. A clone is read so
 * the recorded track is never affected.
 */
export async function nextFrameSize(track: MediaStreamTrack, timeoutMs = 1500): Promise<{ width: number; height: number } | null> {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor
  if (!Processor || track.readyState !== 'live') return null
  const clone = track.clone()
  let reader: FrameReader | null = null
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  try {
    reader = new Processor({ track: clone }).readable.getReader()
    const frame = reader.read().then((r) => {
      const width = r.value?.displayWidth ?? 0
      const height = r.value?.displayHeight ?? 0
      r.value?.close()
      return !r.done && width > 0 && height > 0 ? { width, height } : null
    })
    return await Promise.race([frame, timeout])
  } catch {
    return null
  } finally {
    void reader?.cancel().catch(() => undefined)
    clone.stop()
  }
}
