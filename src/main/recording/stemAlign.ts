import { spawn } from 'node:child_process'
import { stemLag } from '../../shared/audio/align'
import { ffmpegPath } from '../ffmpeg'
import { cancelledError } from './proxyRunner'

/** Analysis rate and the stretch decoded from each file (the stems' offset does not change over time). */
const RATE = 8000
const SPAN = 120

/** Decodes the first audio stream of the input in `input` (ffmpeg input arguments) to mono floats. */
function decode(input: string[], filters: string[], signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError())
    const args = ['-v', 'error', '-nostdin', ...input, '-map', '0:a:0', '-vn', ...(filters.length ? ['-af', filters.join(',')] : []), '-ac', '1', '-ar', String(RATE), '-t', String(SPAN), '-f', 'f32le', 'pipe:1']
    const proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const onAbort = (): void => void proc.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(cancelledError())
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`))
      const all = Buffer.concat(chunks)
      const bytes = new Uint8Array(all.subarray(0, all.length - (all.length % 4)))
      resolve(new Float32Array(bytes.buffer, 0, bytes.length / 4))
    })
  })
}

/**
 * Seconds to add to a stem's offset so it lines up exactly with the mixed sound in the
 * proxy: the stem is placed by its timestamps (`offset`, as stemArgs does), then matched
 * against the proxy's track (shared/audio/align). 0 when they cannot be matched (a silent
 * stem, a mixed sound that does not contain it); the timestamps are then all there is.
 */
export async function measureStemLag(raw: string, proxy: string, offset: number, signal?: AbortSignal): Promise<number> {
  const stem = await decode([...(offset < 0 ? ['-ss', (-offset).toFixed(3)] : []), '-i', raw], offset > 0 ? [`adelay=${Math.round(offset * 1000)}:all=1`] : [], signal)
  const mix = await decode(['-i', proxy], [], signal)
  const match = stemLag(stem, mix, RATE)
  return match ? match.lag / RATE : 0
}
