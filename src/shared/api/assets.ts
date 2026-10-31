/**
 * Downloads for captions (docs/design/captions-studio.md §6.4, §12): the Chinese, Japanese and
 * Korean caption fonts of the catalogue (and, once approved, translation models), each pinned by
 * bytes and SHA-256, stored in userData/caption-assets/. Requests carry catalogue ids only.
 */

/** A downloadable file as it stands on this PC. */
export interface AssetState {
  /** Catalogue id ('noto-sans-jp'). */
  id: string
  kind: 'font' | 'model'
  state: 'missing' | 'downloading' | 'ready'
  /** Bytes on disk when ready (Settings › Downloads for captions). */
  bytes?: number
}

/** A download's progress, sent to the window that asked for it. */
export interface AssetProgress {
  id: string
  received: number
  total: number
  /** The server is busy (HTTP 429 or 503): when the download tries again, epoch ms. */
  retryAt?: number
}

export interface AssetsApi {
  listAssets(): Promise<AssetState[]>
  /** Downloads `id` from its pinned sources in order; rejects with a message to show (§2.10, §12). */
  downloadAsset(id: string): Promise<AssetState>
  cancelAssetDownload(id: string): Promise<void>
  removeAsset(id: string): Promise<void>
  onAssetProgress(listener: (progress: AssetProgress) => void): () => void
}

/** The IPC channels (src/main/assetsIpc.ts checks the sender of each). */
export const ASSETS_CHANNELS = {
  list: 'assets:list',
  download: 'assets:download',
  cancel: 'assets:cancel',
  remove: 'assets:remove',
  progress: 'assets:progress'
} as const

/**
 * The file a downloaded font is stored and served as (userData/caption-assets/<file>,
 * studio-media://assets/<file>): its catalogue id, so the names the store serves are built from the
 * catalogue only (§12).
 */
export const assetFontFile = (id: string): string => `${id}.ttf`
