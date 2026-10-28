import { describe, expect, it, vi } from 'vitest'
import type { ImageOverlay, Project } from '../src/shared/types'

/*
 * Decoding image overlays (docs/design/brand-kit.md §4) from a fake project folder. URLs are
 * matched without their ?v=; a file in `missing` cannot be read, any other loads.
 */

const missing = new Set<string>()
const path = (url: string): string => url.split('?')[0]
const urlOf = (projectId: string, file: string): string => `studio-media://project/${projectId}/${file}`

class FakeImage {
  naturalWidth = 400
  naturalHeight = 200
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  crossOrigin = ''
  decoding = ''
  set src(url: string) {
    setTimeout(() => (missing.has(path(url)) ? this.onerror?.() : this.onload?.()), 0)
  }
}

function fakeCanvas(): Record<string, unknown> {
  const canvas: Record<string, unknown> = { width: 0, height: 0 }
  const ctx = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }
  canvas.getContext = () => ctx
  return canvas
}

vi.stubGlobal('document', { createElement: () => fakeCanvas() })
vi.stubGlobal('Image', FakeImage)
vi.spyOn(console, 'warn').mockImplementation(() => {})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type Source = Pick<ImageOverlay, 'file' | 'sticker'>
type Status = { state: 'loading' } | { state: 'ready'; aspect: number; frames: number } | { state: 'failed'; error: string }
const overlays = (await import(/* @vite-ignore */ `${'../src/renderer/src/render/'}overlayLayer`)) as {
  preloadOverlay: (projectId: string, o: Source, url?: string) => Promise<number>
  overlayStatus: (projectId: string, o: Source) => Status
  prepareOverlays: (p: Pick<Project, 'id' | 'overlays'>) => Promise<void>
  missingOverlays: (p: Pick<Project, 'id' | 'overlays'>) => ImageOverlay[]
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('overlay decoding', () => {
  it('an image whose file was missing shows when it is added again under the same name', async () => {
    const o = { file: 'overlay-1.png' }
    missing.add(urlOf('p6', o.file))
    overlays.overlayStatus('p6', o)
    await settle()
    expect(overlays.overlayStatus('p6', o)).toEqual({ state: 'failed', error: 'This image could not be read.' })
    // "Add image…" again: main writes the same name back, and the editor preloads it.
    missing.delete(urlOf('p6', o.file))
    await expect(overlays.preloadOverlay('p6', o, urlOf('p6', o.file))).resolves.toBe(2)
    expect(overlays.overlayStatus('p6', o)).toEqual({ state: 'ready', aspect: 2, frames: 1 })
  })
})
