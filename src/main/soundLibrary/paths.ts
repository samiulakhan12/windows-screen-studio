/**
 * Where the sound library's files are (docs/design/editing-polish.md §10.3): the bundled folder
 * (process.resourcesPath/sound-library, or resources/sound-library unpackaged) and
 * userData/sound-library for downloaded beds.
 *
 * Only the catalogue's file names are ever resolved (soundFileRe: no path parts), each in the one
 * folder it belongs to: the effects and the bundled beds in the bundled folder, the other beds in
 * the downloads folder. The media protocol's `sounds` host serves exactly these (§14 rule 2).
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { MUSIC_BEDS, SOUND_EFFECTS, soundFileRe } from '../../shared/audio/soundLibrary'

/** The folder under userData that holds the downloaded beds. */
export const SOUND_LIBRARY_DIR = 'sound-library'

let overrides: { bundled?: string; downloaded?: string } = {}

/** Replaces the folders (tests); `null` restores the real ones. */
export function configureSoundPaths(next: { bundled?: string; downloaded?: string } | null): void {
  overrides = next ?? {}
}

/** The bundled library folder: resources/sound-library, shipped outside app.asar so ffmpeg reads it from a real path. */
export function bundledSoundDir(): string {
  if (overrides.bundled) return overrides.bundled
  return app.isPackaged ? path.join(process.resourcesPath, SOUND_LIBRARY_DIR) : path.join(app.getAppPath(), 'resources', SOUND_LIBRARY_DIR)
}

/** userData/sound-library: the beds downloaded on request. */
export function downloadedSoundDir(): string {
  return overrides.downloaded ?? path.join(app.getPath('userData'), SOUND_LIBRARY_DIR)
}

/** The folder a library file belongs in: bundled (every effect, the bundled beds) or downloaded; null for any other name. */
export function soundFolder(file: string): string | null {
  if (typeof file !== 'string' || !soundFileRe().test(file)) return null
  if (SOUND_EFFECTS.some((e) => e.prepared.file === file)) return bundledSoundDir()
  const bed = MUSIC_BEDS.find((b) => b.prepared.file === file)
  if (!bed) return null
  return bed.bundled ? bundledSoundDir() : downloadedSoundDir()
}

/** The path of a library file by its catalogue name, or null when it is not one (or not there). */
export function soundPath(file: string): string | null {
  const dir = soundFolder(file)
  if (!dir) return null
  const p = path.join(dir, file)
  return existsSync(p) ? p : null
}
