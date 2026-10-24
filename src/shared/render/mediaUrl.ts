/**
 * URL of another file of the same project, from the screen proxy's URL
 * (`studio-media://project/<id>/screen.mp4?v=...` -> `.../<file>?v=...`).
 */
export function projectMediaUrl(screenUrl: string, file: string): string {
  const url = new URL(screenUrl)
  const parts = url.pathname.split('/')
  parts[parts.length - 1] = encodeURIComponent(file)
  url.pathname = parts.join('/')
  return url.toString()
}
