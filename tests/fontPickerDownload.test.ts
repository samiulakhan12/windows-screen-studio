import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetProgress, AssetState } from '../src/shared/api/assets'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { Project } from '../src/shared/types'
import { contexts, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The Font menu's Download for a caption font that is not on this PC (docs/design/captions-studio.md
 * §2.6, §6.4), without a DOM: once the download is done the font is loaded, so the preview draws
 * with it as the export does; a menu made again while the download runs (another panel and back)
 * follows it to its end.
 */

const ASSET = 'studio-media://assets/noto-sans-jp.ttf'
/** studio-media URLs fetch finds. */
const files = new Set<string>()
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.stubGlobal('document', { activeElement: null, body: {}, createElement: () => ({ getContext: () => null }), fonts: { add: () => undefined, delete: () => undefined } })
vi.stubGlobal(
  'FontFace',
  class {
    constructor(
      public family: string,
      public source: unknown
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

/** What listAssets answers, and the download under way (the test ends it). */
let listed: AssetState[] = []
let finish: (s: AssetState) => void = () => undefined
let fail: (err: Error) => void = () => undefined
const api = {
  listAssets: async () => listed,
  downloadAsset: vi.fn(
    (id: string) =>
      new Promise<AssetState>((resolve, reject) => {
        listed = [{ id, kind: 'font', state: 'downloading' }]
        finish = resolve
        fail = reject
      })
  ),
  cancelAssetDownload: async () => undefined,
  onAssetProgress: (_l: (p: AssetProgress) => void) => () => undefined
}
vi.stubGlobal('window', { devicePixelRatio: 1, api, addEventListener: () => undefined, removeEventListener: () => undefined })

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PICKER = '../src/renderer/src/editor/panels/FontPicker'
const LOADER = '../src/renderer/src/render/fontLoader'
const { FontPicker } = (await import(/* @vite-ignore */ PICKER)) as { FontPicker: (p: unknown) => unknown }
const fonts = (await import(/* @vite-ignore */ LOADER)) as {
  ensureCaptionFonts(p: Project): void
  catalogFontReady(id: string): boolean
  fontGeneration(): number
}
await useEditorContexts()

const studio = { ...structuredClone(studioPreset('subtitle')!.look), text: { ...structuredClone(studioPreset('subtitle')!.look.text), font: 'cat:noto-sans-jp' } }
/** A Japanese project whose Studio look uses Noto Sans JP, a download (a new object each time: as the store makes one per edit). */
const project = (): Project =>
  ({
    id: 'p1',
    annotations: [],
    titles: [],
    fonts: [],
    clips: [{ start: 0, end: 10, speed: 1 }],
    transcript: { language: 'ja', segments: [{ id: 'c1', start: 0, end: 2, text: '動画を書き出す' }] },
    captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#ffe14d', background: 'shadow', maxLines: 2, studio }
  }) as unknown as Project

const view = (): unknown => ({ type: FontPicker, props: { project: project(), value: 'cat:noto-sans-jp', apply: (p: Project) => p, catalogue: true, language: 'ja' } })
const downloadButton = (els: El[]): El | undefined => els.find((e) => e.type === 'button' && textOf(e).startsWith('Download ('))
const row = (els: El[]): El | undefined => els.find((e) => e.props['data-testid'] === 'font-download')
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  unmountAll()
  contexts.editor = { store: testStore(project()) }
})

describe('Download in the Font menu (§2.6, §6.4)', () => {
  it('loads the font once it is downloaded, so the preview draws with it (not only the export)', async () => {
    // The preview tried the font before it was on this PC: it is missing.
    fonts.ensureCaptionFonts(project())
    await flush()
    expect(fonts.catalogFontReady('noto-sans-jp')).toBe(false)

    let els = await settle(view())
    ;(downloadButton(els)!.props.onClick as () => void)()
    files.add(ASSET)
    const generation = fonts.fontGeneration()
    finish({ id: 'noto-sans-jp', kind: 'font', state: 'ready', bytes: 9589900 })
    listed = [{ id: 'noto-sans-jp', kind: 'font', state: 'ready', bytes: 9589900 }]
    els = await settle(view())

    expect(row(els)).toBeUndefined()
    expect(fonts.catalogFontReady('noto-sans-jp')).toBe(true)
    // Every view that draws with fonts paints again.
    expect(fonts.fontGeneration()).toBeGreaterThan(generation)
    // The preview's next frame (a new project object) finds it ready.
    fonts.ensureCaptionFonts(project())
    expect(fonts.catalogFontReady('noto-sans-jp')).toBe(true)
  })

  it('a menu made again while the download runs follows it to its end', async () => {
    listed = []
    const started = api.downloadAsset.mock.calls.length
    let els = await settle(view())
    ;(downloadButton(els)!.props.onClick as () => void)()
    // Another panel and back: the menu is made again.
    unmountAll()
    els = await settle(view())
    expect(textOf(row(els))).toMatch(/^Downloading Noto Sans JP/)
    finish({ id: 'noto-sans-jp', kind: 'font', state: 'ready', bytes: 9589900 })
    listed = [{ id: 'noto-sans-jp', kind: 'font', state: 'ready', bytes: 9589900 }]
    els = await settle(view())
    expect(row(els)).toBeUndefined()
    // One download: the menu made again did not start another.
    expect(api.downloadAsset.mock.calls.length).toBe(started + 1)
  })

  it('a menu made again shows why the download stopped, and Download again', async () => {
    listed = []
    let els = await settle(view())
    ;(downloadButton(els)!.props.onClick as () => void)()
    unmountAll()
    els = await settle(view())
    fail(new Error("Error invoking remote method 'assets:download': Error: The download was cancelled."))
    listed = [{ id: 'noto-sans-jp', kind: 'font', state: 'missing' }]
    els = await settle(view())
    expect(textOf(els.find((e) => e.props.role === 'alert'))).toBe('The download was cancelled.')
    expect(downloadButton(els)).toBeDefined()
  })
})
