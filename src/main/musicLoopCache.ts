/**
 * Users' own looping Opus, M4A and AAC music decoded once into the project's .cache/ (docs/design/
 * editing-polish.md §0 decision 2, §10.4), so the export loops it without a glitch.
 *
 * Contracts step: the exported signature of part P5 (§17.5), a stub that returns the file as it
 * is (the export reads it as today). Part P5 writes the body.
 */
export async function loopableMusic(projectDir: string, file: string, ffmpeg: string, opts: { seconds: number; signal: AbortSignal; timeoutMs: number }): Promise<string> {
  void projectDir
  void ffmpeg
  void opts
  return file
}
