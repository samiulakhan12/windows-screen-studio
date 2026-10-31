/**
 * The store of downloaded caption assets (docs/design/captions-studio.md §12): pinned files in
 * userData/caption-assets/, downloaded from their sources in order (Retry-After honoured), checked
 * by bytes and SHA-256, served through studio-media://assets/ by name only.
 *
 * CONTRACT (part P2): signatures are frozen; bodies are to be written.
 */
import type { AssetProgress, AssetState } from '../../shared/api/assets'

/** The body of a frozen signature part P2 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P2)`)
}

/** The folder under userData that holds the assets. */
export const ASSET_DIR = 'caption-assets'

/** The file names the store serves: only names built from the catalogues. */
export function assetFileRe(): RegExp {
  return notImplemented('assetFileRe')
}

export async function listAssets(): Promise<AssetState[]> {
  return notImplemented('listAssets')
}

export async function downloadAsset(id: string, opts: { signal: AbortSignal; onProgress(p: AssetProgress): void }): Promise<AssetState> {
  return notImplemented('downloadAsset', id, opts)
}

export async function removeAsset(id: string): Promise<void> {
  return notImplemented('removeAsset', id)
}

/** Whether a download (or redirect) may go to `url`: https, port 443, no credentials, the pinned prefixes only (§12). */
export function allowAssetUrl(url: URL, testBase?: string | null): boolean {
  return notImplemented('allowAssetUrl', url, testBase)
}
