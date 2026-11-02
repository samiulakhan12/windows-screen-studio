/**
 * Keeps the MediaPipe workers off the network (docs/design/sound-finder.md §7): the sound worker and the
 * camera's background-blur worker (render/segmentation). MediaPipe Tasks posts usage statistics to Google
 * (odml.pa.googleapis.com) once a minute while a classifier or segmenter is alive, and a module worker
 * loaded from file:// is not covered by the page's Content Security Policy. So the worker's fetch
 * reaches only the app's own files: the same host as the worker ('' under file://, localhost in dev).
 * MediaPipe's sender treats the refusal as a failed send and stops trying; the worker goes on.
 */
export function keepOffline(scope: { fetch: typeof fetch; location: { href: string; host: string } }): void {
  const own = scope.fetch.bind(scope)
  scope.fetch = (input, init) =>
    new URL(input instanceof Request ? input.url : String(input), scope.location.href).host === scope.location.host
      ? own(input, init)
      : Promise.reject(new TypeError('Flown makes no network requests'))
}
