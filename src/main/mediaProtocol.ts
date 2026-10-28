import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { MEDIA_SCHEME } from '../shared/mediaUrl'
import { projectDir } from './projects'

export { MEDIA_SCHEME, mediaUrl } from '../shared/mediaUrl'

/** Project files the renderer may load: the proxies, a background image, a custom cursor image, picked assets, image overlays and fonts. */
export const MEDIA_FILE_RE =
  /^(screen\.mp4|webcam\.mp4|background\.(png|jpe?g|webp)|cursor\.(png|jpe?g|webp|svg|ico|cur)|watermark(-[1-9][0-9]{0,8})?\.(png|jpg|webp|svg)|music(-[1-9][0-9]{0,8})?\.(mp3|m4a|aac|wav|ogg|opus|flac)|(mic|system)\.m4a|overlay-[1-9][0-9]{0,8}\.(png|jpg|webp|svg|gif)|font-[1-9][0-9]{0,8}\.(ttf|otf|woff2))$/i
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac'
}

// Frames are read back from canvas during export, so media must be CORS-clean.
const CORS = { 'Access-Control-Allow-Origin': '*' }

/**
 * Extra headers per type: a user's SVG is only ever an image, never a document that runs scripts;
 * fonts are read as bytes (FontFace) and never sniffed into another type.
 */
const typeHeaders = (type: string): Record<string, string> =>
  type === 'image/svg+xml'
    ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'X-Content-Type-Options': 'nosniff' }
    : type.startsWith('font/')
      ? { 'X-Content-Type-Options': 'nosniff' }
      : {}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

/**
 * Serves project media with HTTP Range support so <video> can seek.
 * Only whitelisted files inside a project folder are reachable.
 */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const [id, file] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (url.host !== 'project' || !id || !file || !MEDIA_FILE_RE.test(file)) return new Response('Not found', { status: 404 })
      const filePath = path.join(projectDir(id), file)
      const { size } = await fs.stat(filePath)
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      const range = request.headers.get('range')
      const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
      if (match && (match[1] || match[2])) {
        let start = match[1] ? Number(match[1]) : size - Number(match[2])
        let end = match[1] && match[2] ? Number(match[2]) : size - 1
        start = Math.max(0, start)
        end = Math.min(end, size - 1)
        if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            ...typeHeaders(type),
            ...CORS
          }
        })
      }
      const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...typeHeaders(type), ...CORS }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
