/**
 * The unwanted-sound finder (docs/design/sound-finder.md §4.7, §7) between the editor and the main
 * process. The editor names a project and a source; the main process finds the file, decodes it to
 * 16 kHz mono float samples with ffmpeg and hands them out chunk by chunk to the window that asked,
 * and keeps the scores in the project's .cache/sounds.json. Every channel accepts the app's own page
 * only, and the main process checks every argument.
 */
import type { AudioSource } from '../audio/settings'
import type { SoundCacheEntry } from '../audio/soundsCache'

export const SOUNDS_CHANNELS = {
  /** invoke (projectId, source) → SoundCacheEntry | null: the stored scores when the file has not changed */
  cached: 'sounds:cached',
  /** invoke (projectId, source) → SoundStreamInfo; starts decoding */
  open: 'sounds:open',
  /** invoke (stream) → ArrayBuffer of float samples (at most SOUND_CHUNK_BYTES), or null at the end; rejects with a sentence */
  read: 'sounds:read',
  /** invoke (stream) → void; stops decoding */
  close: 'sounds:close',
  /** invoke (projectId, source, entry) → void; refused when the entry is malformed or the file changed */
  save: 'sounds:save'
} as const

/** Bytes of samples a read returns at most: 20 s of 16 kHz mono float. */
export const SOUND_CHUNK_BYTES = 20 * 16000 * 4

/** What a read rejects with once the project's work was stopped (the editor closed, the project is being deleted). */
export const SOUNDS_STOPPED = 'Listening was stopped.'

/** A decoding stream, and the file it reads as it is now (the cache entry made from it carries both). */
export interface SoundStreamInfo {
  stream: number
  size: number
  mtimeMs: number
}

export interface SoundsApi {
  soundsCached(projectId: string, source: AudioSource): Promise<SoundCacheEntry | null>
  soundsOpen(projectId: string, source: AudioSource): Promise<SoundStreamInfo>
  soundsRead(stream: number): Promise<ArrayBuffer | null>
  soundsClose(stream: number): Promise<void>
  soundsSave(projectId: string, source: AudioSource, entry: SoundCacheEntry): Promise<void>
}
