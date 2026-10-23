/** Epoch milliseconds with sub-millisecond precision (same clock as Date.now()). */
export const epochNow = (): number => performance.timeOrigin + performance.now()

interface FrameReader {
  read(): Promise<{ value?: { close(): void }; done: boolean }>
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
