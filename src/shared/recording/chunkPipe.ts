export interface BlobLike {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * Streams one MediaRecorder's chunks to the main process in order, one at a time.
 * Only the chunk in flight is held in memory; on the first failure the pipe stops
 * and reports it (what was written so far stays on disk).
 */
export class ChunkPipe {
  private chain: Promise<void> = Promise.resolve()
  private failure: unknown = null
  bytes = 0

  constructor(
    private readonly send: (data: Uint8Array) => Promise<void>,
    private readonly onError: (err: unknown) => void
  ) {}

  get error(): unknown {
    return this.failure
  }

  push(blob: BlobLike): void {
    if (this.failure || blob.size === 0) return
    this.chain = this.chain.then(async () => {
      if (this.failure) return
      try {
        const data = new Uint8Array(await blob.arrayBuffer())
        await this.send(data)
        this.bytes += data.byteLength
      } catch (err) {
        this.failure = err
        this.onError(err)
      }
    })
  }

  /** Resolves once every pushed chunk has been written (or the pipe failed). */
  flush(): Promise<void> {
    return this.chain
  }
}
