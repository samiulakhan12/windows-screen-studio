import { describe, expect, it, vi } from 'vitest'
import type { Project, ProjectFont } from '../src/shared/types'

/*
 * Loading a project's fonts (docs/design/brand-kit.md §4.3) from a fake project folder: fetch
 * finds only the files in `files` (URLs without their ?v=), and FontFace accepts any bytes.
 */

const files = new Set<string>()
vi.stubGlobal('document', { fonts: { add() {}, delete() {} } })
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.stubGlobal(
  'FontFace',
  class {
    constructor(
      public family: string,
      public data: ArrayBuffer
    ) {}
    async load(): Promise<unknown> {
      return this
    }
  }
)
vi.stubGlobal('fetch', async (url: string) => {
  const ok = files.has(url.split('?')[0])
  return { ok, status: ok ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(8) }
})

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type ProjectFonts = Pick<Project, 'id' | 'fonts' | 'annotations' | 'titles' | 'captions'>
const fonts = (await import(/* @vite-ignore */ `${'../src/renderer/src/render/'}fontLoader`)) as {
  ensureProjectFonts: (p: ProjectFonts) => void
  fontState: (p: ProjectFonts, id: string) => string | null
  missingFonts: (p: ProjectFonts) => ProjectFont[]
  preloadProjectFont: (projectId: string, font: ProjectFont, url?: string) => Promise<void>
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('font loading', () => {
  it('a font whose file was missing loads when it is added again under the same name', async () => {
    const font = { id: 'f9', name: 'Brand', file: 'font-1.ttf' }
    const url = 'studio-media://project/p1/font-1.ttf'
    const project = { id: 'p1', fonts: [font], annotations: [{ id: 'a', start: 0, end: 1, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, font: 'f9' }], titles: [] } as unknown as ProjectFonts
    fonts.ensureProjectFonts(project)
    await settle()
    expect(fonts.fontState(project, 'f9')).toBe('missing')
    // "Add the font again": main writes the same name back, and the picker preloads it.
    files.add(url)
    await fonts.preloadProjectFont('p1', font, url)
    expect(fonts.fontState(project, 'f9')).toBe('ready')
    expect(fonts.missingFonts(project)).toEqual([])
  })

  it('a font that still cannot be read is refused again', async () => {
    const font = { id: 'f2', name: 'Gone', file: 'font-2.ttf' }
    const url = 'studio-media://project/p2/font-2.ttf'
    await expect(fonts.preloadProjectFont('p2', font, url)).rejects.toThrow('This font could not be read.')
    await expect(fonts.preloadProjectFont('p2', font, url)).rejects.toThrow('This font could not be read.')
  })
})
