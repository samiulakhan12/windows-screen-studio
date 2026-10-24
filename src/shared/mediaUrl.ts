/**
 * URLs of files inside a project folder, served by the main process's studio-media://
 * protocol (src/main/mediaProtocol.ts, which decides which files are reachable).
 * Shared so the renderer can name a project file (e.g. a custom cursor image) without
 * asking main for a URL first.
 */

export const MEDIA_SCHEME = 'studio-media'

/** URL of `file` in project `projectId`. `version` defeats caching when a file is replaced. */
export const mediaUrl = (projectId: string, file: string, version: number = Date.now()): string =>
  `${MEDIA_SCHEME}://project/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}?v=${version}`

/** file -> URL for one project (the shape prepareCursorAssets and similar loaders take). */
export const projectMediaUrl =
  (projectId: string): ((file: string) => string) =>
  (file) =>
    mediaUrl(projectId, file)
