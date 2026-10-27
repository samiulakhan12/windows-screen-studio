import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioLevels } from '../src/shared/audio/loudness'
import type { AudioSource } from '../src/shared/audio/settings'
import type { AudioAnalysis } from '../src/shared/audio/soundtrack'

/*
 * loadAudioAnalysis (audioAnalysis.ts): the session's levels of a project's sources, shared by
 * the preview, the exporter, Remove silences, the waveform, the director and Polish. The main
 * process is stubbed; the module is fresh for every test (its cache lives for the session).
 */

const analyzeAudio = vi.fn<(id: string, sources: AudioSource[]) => Promise<AudioAnalysis>>()
vi.stubGlobal('window', { api: { analyzeAudio } })

interface Analysis {
  loadAudioAnalysis(projectId: string, sources: readonly AudioSource[]): Promise<AudioAnalysis>
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const MODULE = '../src/renderer/src/editor/audioAnalysis'

let analysis: Analysis

beforeEach(async () => {
  vi.resetModules()
  analyzeAudio.mockReset()
  analysis = (await import(/* @vite-ignore */ MODULE)) as Analysis
})

const levels = (n: number): AudioLevels => ({ window: 0.05, power: new Float32Array(n).fill(1e-4) })

describe('loadAudioAnalysis', () => {
  it('measures each source once per session, in one request for the ones not measured yet', async () => {
    const mic = levels(4)
    const system = levels(5)
    analyzeAudio.mockResolvedValueOnce({ mic })
    expect(await analysis.loadAudioAnalysis('p1', ['mic'])).toEqual({ mic })
    analyzeAudio.mockResolvedValueOnce({ system })
    expect(await analysis.loadAudioAnalysis('p1', ['mic', 'system'])).toEqual({ mic, system })
    expect(analyzeAudio.mock.calls).toEqual([
      ['p1', ['mic']],
      ['p1', ['system']]
    ])
  })

  it('leaves out every source of a request that failed, without rejecting, and asks again on the next call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // One stem ffmpeg cannot decode fails the whole request (main/audioAnalysis.ts).
    analyzeAudio.mockRejectedValueOnce(new Error('Could not read the sound of system.m4a'))
    await expect(analysis.loadAudioAnalysis('p1', ['mic', 'system'])).resolves.toEqual({})
    expect(warn).toHaveBeenCalledTimes(2)
    const mic = levels(4)
    const system = levels(5)
    analyzeAudio.mockResolvedValueOnce({ mic, system })
    expect(await analysis.loadAudioAnalysis('p1', ['mic', 'system'])).toEqual({ mic, system })
    expect(analyzeAudio).toHaveBeenLastCalledWith('p1', ['mic', 'system'])
    await analysis.loadAudioAnalysis('p1', ['system', 'mic'])
    expect(analyzeAudio).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('leaves out a source the main process found no file for', async () => {
    const mic = levels(4)
    analyzeAudio.mockResolvedValueOnce({ mic })
    expect(await analysis.loadAudioAnalysis('p1', ['mic', 'system'])).toEqual({ mic })
  })
})
