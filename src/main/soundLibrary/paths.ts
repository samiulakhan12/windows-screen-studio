/**
 * Where the sound library's files are (docs/design/editing-polish.md §10.3): the bundled folder
 * (process.resourcesPath/sound-library, or resources/sound-library unpackaged) and
 * userData/sound-library for downloaded beds.
 *
 * Contracts step: the exported signatures of part P5 (§17.5), stubs. Part P5 writes the bodies.
 */
import path from 'node:path'

export function bundledSoundDir(): string {
  return path.join(process.resourcesPath ?? '', 'sound-library')
}

/** The path of a library file by its catalogue name, or null when it is not one (or not there). */
export function soundPath(file: string): string | null {
  void file
  return null
}
