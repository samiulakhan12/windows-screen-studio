import { beforeEach, describe, expect, it, vi } from 'vitest'
import { byTestId, mockReact, settle, textOf, unmountAll } from './studioHarness'

/*
 * Settings › Downloads for captions (docs/design/captions-studio.md §2.12): a row per downloaded
 * font with the bytes it uses, its licence and Remove. The assets API is part P2's main process.
 */

const assets = { list: [] as unknown[], removed: [] as string[], fail: false }
vi.stubGlobal('window', {
  api: {
    listAssets: async () => {
      if (assets.fail) throw new Error("Error invoking remote method 'assets:list': Error: No handler registered for 'assets:list'")
      return assets.list
    },
    removeAsset: async (id: string) => {
      assets.removed.push(id)
      assets.list = assets.list.filter((a) => (a as { id: string }).id !== id)
    }
  }
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/settings/CaptionDownloadsSection'
const { CaptionDownloadsSection, downloadRow } = (await import(/* @vite-ignore */ SECTION)) as {
  CaptionDownloadsSection: () => unknown
  downloadRow: (a: unknown) => { name: string; text: string }
}
const view = { type: CaptionDownloadsSection, props: {} }

beforeEach(() => {
  unmountAll()
  assets.list = []
  assets.removed = []
  assets.fail = false
})

describe('Downloads for captions', () => {
  it('words a downloaded font with its script, its size on disk and its licence', () => {
    expect(downloadRow({ id: 'noto-sans-jp', kind: 'font', state: 'ready', bytes: 9_600_000 }).text).toBe('Noto Sans JP · Japanese caption font · 9.6 MB · SIL Open Font License')
    expect(downloadRow({ id: 'en-bn', kind: 'model', state: 'ready', bytes: 21_300_000 }).text).toBe('en-bn · translation model · 21.3 MB · Mozilla Public License 2.0')
  })

  it('lists what is on this PC and removes one', async () => {
    assets.list = [
      { id: 'noto-sans-kr', kind: 'font', state: 'ready', bytes: 10_100_000 },
      { id: 'noto-sans-jp', kind: 'font', state: 'missing' }
    ]
    let els = await settle(view)
    const rows = els.filter((e) => e.props.className === 'caption-download-row')
    expect(rows.map((r) => textOf(r))).toEqual(['Noto Sans KR · Korean caption font · 10.1 MB · SIL Open Font LicenseRemove'])
    const remove = els.find((e) => e.props['aria-label'] === 'Remove Noto Sans KR')!
    ;(remove.props.onClick as () => void)()
    els = await settle(view)
    expect(assets.removed).toEqual(['noto-sans-kr'])
    expect(textOf(byTestId(els, 'caption-downloads')!)).toContain('Nothing downloaded.')
  })

  it('says when the list cannot be read', async () => {
    assets.fail = true
    const els = await settle(view)
    expect(textOf(els.find((e) => e.props.role === 'alert')!)).toBe("The downloads could not be listed: No handler registered for 'assets:list'")
  })
})
