import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

/**
 * Appends MediaRecorder chunks to a file as they arrive, so a recording never has
 * to fit in memory and survives a renderer crash. Writes are serialised.
 */
export class ChunkWriter {
  private handle: Promise<FileHandle>
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  bytes = 0

  constructor(readonly file: string) {
    this.handle = fs.open(file, 'w')
    // Surfaced by the first write/close instead of as an unhandled rejection.
    this.handle.catch(() => undefined)
  }

  write(data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The recording file is already closed'))
    const next = this.chain.then(async () => {
      const fh = await this.handle
      let offset = 0
      while (offset < data.byteLength) {
        const { bytesWritten } = await fh.write(data, offset, data.byteLength - offset)
        offset += bytesWritten
      }
      this.bytes += data.byteLength
    })
    // A failed write must not block later ones from reporting their own errors.
    this.chain = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.chain
    try {
      await (await this.handle).close()
    } catch {
      // Opening failed; the write that hit it already reported the error.
    }
  }
}
