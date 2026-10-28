import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_MAX_BYTES } from '../src/shared/engine/overlayData'

/** Ctrl+V's image part (pasteClipboardImage): what it does with the image main reports on the clipboard. */
const h = vi.hoisted(() => ({ image: null as { hash: string; size: number; png?: Uint8Array } | null, imported: 0 }))

vi.mock('../src/renderer/src/render/overlayLayer', () => ({ preloadOverlay: async () => 1 }))
vi.stubGlobal('window', {
  api: {
    // Main sends the bytes only when asked, and never for an image over 25 MB.
    clipboardImage: async (withBytes: boolean) => (h.image && { hash: h.image.hash, size: h.image.size, ...(withBytes && h.image.png ? { png: h.image.png } : {}) }),
    importAssetData: async () => {
      h.imported++
      throw new Error('not reached in these tests')
    }
  }
})

interface OverlayItems {
  noteItemCopy(): void
  pasteClipboardImage(services: unknown, opts: { onSelect: () => void }, itemsCopied: boolean): Promise<unknown>
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const ITEMS = '../src/renderer/src/editor/overlayItems'
const { noteItemCopy, pasteClipboardImage } = (await import(/* @vite-ignore */ ITEMS)) as OverlayItems

const services = { store: { state: { id: 'rec-paste', overlays: [] } }, player: { time: 0 } }
const paste = (itemsCopied: boolean) => pasteClipboardImage(services, { onSelect: () => undefined }, itemsCopied)

beforeEach(() => {
  h.image = null
  h.imported = 0
})

describe('pasting the clipboard image with Ctrl+V', () => {
  it('pastes the copied items when the clipboard holds no image', async () => {
    expect(await paste(true)).toBeNull()
  })

  it('says an image over 25 MB is too large, instead of pasting the copied items', async () => {
    h.image = { hash: 'big', size: 31e6 }
    await expect(paste(true)).rejects.toThrow(/^The pasted image is too large \(30 MB; 25 MB at most\)\.$/)
    await expect(paste(false)).rejects.toThrow(/too large/)
    expect(h.imported).toBe(0)
  })

  it('pastes the copied items when that large image was already on the clipboard when they were copied', async () => {
    h.image = { hash: 'big', size: OVERLAY_MAX_BYTES + 1 }
    noteItemCopy()
    expect(await paste(true)).toBeNull()
    // A new image copied after the items is pasted (here: refused for its size).
    h.image = { hash: 'newer', size: OVERLAY_MAX_BYTES + 1 }
    await expect(paste(true)).rejects.toThrow(/too large/)
  })
})
