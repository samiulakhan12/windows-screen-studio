import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { projectDir } from './projects'

export const MEDIA_SCHEME = 'studio-media'

const FILE_RE = /^(screen\.mp4|webcam\.mp4|background\.(png|jpe?g|webp))$/i
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

// Frames are read back from canvas during export, so media must be CORS-clean.
const CORS = { 'Access-Control-Allow-Origin': '*' }

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

export const mediaUrl = (projectId: string, file: string): string =>
  `${MEDIA_SCHEME}://project/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}?v=${Date.now()}`

/**
 * Serves project media with HTTP Range support so <video> can seek.
 * Only whitelisted files inside a project folder are reachable.
 */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const [id, file] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (url.host !== 'project' || !id || !file || !FILE_RE.test(file)) return new Response('Not found', { status: 404 })
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
            ...CORS
          }
        })
      }
      const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...CORS }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
