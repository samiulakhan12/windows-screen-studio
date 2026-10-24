import type { AudioLevels } from '../../../shared/audio/loudness'
import type { AudioSource } from '../../../shared/audio/settings'
import type { AudioAnalysis } from '../../../shared/audio/soundtrack'

/**
 * Sound levels of a project's recorded sources, measured once by the main process and shared
 * by the preview and the exporter (so the music ducks at the same moments in both). Each
 * source is requested at most once per editor session; a failed measurement is retried on
 * the next request.
 */
const cache = new Map<string, Promise<AudioLevels | null>>()

const key = (projectId: string, source: AudioSource): string => `${projectId}\u0000${source}`

/** Levels of `sources` of project `projectId` that could be measured (a source without sound is left out). */
export async function loadAudioAnalysis(projectId: string, sources: readonly AudioSource[]): Promise<AudioAnalysis> {
  const missing = sources.filter((s) => !cache.has(key(projectId, s)))
  if (missing.length > 0) {
    const request = window.api.analyzeAudio(projectId, missing)
    for (const s of missing) {
      const k = key(projectId, s)
      const one = request.then((all) => all[s] ?? null)
      cache.set(k, one)
      one.catch(() => cache.delete(k))
    }
  }
  const out: AudioAnalysis = {}
  for (const s of sources) {
    const levels = await cache.get(key(projectId, s))!.catch((err: unknown) => {
      console.warn(`Could not measure the ${s} sound:`, err)
      return null
    })
    if (levels) out[s] = levels
  }
  return out
}
