// Measuring how far a recorded stem is from the mixed sound in the proxy, with real files.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { measureStemLag } from '../src/main/recording/stemAlign'
import { isCancelled } from '../src/main/recording/proxyRunner'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-stem-align-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const ff = ffmpegPath()
/** Speech-like bursts of noise (0.3 s every 0.7 s) over 8 s. */
const bursts = "anoisesrc=color=pink:amplitude=0.3:seed=11:sample_rate=48000,volume='if(lt(mod(t,0.7),0.3),1,0)':eval=frame"

function make(name: string, filters: string, codec: string[]): string {
  const file = path.join(dir, name)
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', bursts, '-t', '8', ...(filters ? ['-af', filters] : []), ...codec, file])
  return file
}

describe('measureStemLag', () => {
  const stem = make('mic.webm', '', ['-c:a', 'libopus'])

  it('finds how much later the mixed sound has the stem', async () => {
    // The proxy's track: the same sound 23 ms later (and quieter, with another source mixed in).
    const proxy = path.join(dir, 'screen.m4a')
    execFileSync(ff, [
      '-v', 'error', '-f', 'lavfi', '-i', bursts, '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
      '-filter_complex', '[0:a]adelay=23:all=1,volume=0.7[a];[1:a]volume=0.5[b];[a][b]amix=inputs=2:normalize=0', '-t', '8', '-c:a', 'aac', proxy
    ])
    const lag = await measureStemLag(stem, proxy, 0)
    expect(lag).toBeCloseTo(0.023, 3)
    // The stem's own offset is applied first; only the rest is reported.
    expect(await measureStemLag(stem, proxy, 0.01)).toBeCloseTo(0.013, 3)
  })

  it('reports nothing for a proxy that does not contain the stem', async () => {
    const other = make('other.m4a', 'atempo=1.3', ['-c:a', 'aac'])
    expect(await measureStemLag(stem, other, 0)).toBe(0)
  })

  it('stops for "Finish later"', async () => {
    const abort = new AbortController()
    abort.abort()
    const err = await measureStemLag(stem, stem, 0, abort.signal).catch((e: unknown) => e)
    expect(isCancelled(err)).toBe(true)
  })
})
