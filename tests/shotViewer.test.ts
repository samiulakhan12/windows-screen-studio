import { beforeEach, describe, expect, it, vi } from 'vitest'
import { byTestId, focused, key, mockReact, render, textOf, unmountAll, type El } from './studioHarness'
import type { GuideStepEdit, NormRect } from '../src/shared/types'

/*
 * The full-size screenshot viewer (docs/design/smart-tools.md §2.1.2, §5.5.3) without a DOM: test 112
 * of §22.1 (Adjust: Done stores the crop and the ring together, Reset removes them, a crop under
 * 5% is refused, the keyboard moves the ring by 1% and 10%), with Check screenshots' count.
 */

vi.stubGlobal('HTMLElement', class {})
vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })

mockReact()
const VIEWER = '../src/renderer/src/guide/ShotViewer'
const { ShotViewer } = (await import(/* @vite-ignore */ VIEWER)) as { ShotViewer: (p: unknown) => unknown }

const image = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 950, height: 534 }
const frame = { bytes: new Uint8Array([4, 5, 6]), mime: 'image/png', width: 1920, height: 1080 }
const shots = (rect: NormRect = { x: 0.3, y: 0.2, w: 0.5, h: 0.5 }): unknown[] => [
  { key: 'c3000', label: 'step 1', image, adjust: { frame, rect, ring: { x: 0.5, y: 0.5 } } },
  { key: 'c12000', label: 'step 2', image, adjust: { frame, rect, ring: null } }
]

const calls = { adjusted: [] as [string, Pick<GuideStepEdit, 'rect' | 'ring'> | null][], shown: [] as string[], closed: 0, blurred: [] as string[] }
let props: Record<string, unknown>
const viewer = (): unknown => ({ type: ShotViewer, props })
const press = (el: El | undefined, k: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}): ReturnType<typeof key> => {
  const e = key(k, mods)
  ;(el!.props.onKeyDown as (e: unknown) => void)(e)
  return e
}
const click = (el: El | undefined): void => void (el!.props.onClick as () => void)()

beforeEach(() => {
  unmountAll()
  calls.adjusted = []
  calls.shown = []
  calls.closed = 0
  calls.blurred = []
  props = {
    shots: shots(),
    index: 0,
    mode: 'view',
    total: 7,
    onShown: (k: string) => calls.shown.push(k),
    onClose: () => calls.closed++,
    onBlur: (k: string) => calls.blurred.push(k),
    onAdjust: (k: string, e: Pick<GuideStepEdit, 'rect' | 'ring'> | null) => calls.adjusted.push([k, e])
  }
})

describe('the viewer', () => {
  it('shows the shot at 100% (its own size), named by its step and the guide’s count, with the focus in the scrolling area', () => {
    const els = render(viewer())
    expect(textOf(els.find((e) => e.type === 'h2'))).toBe('Screenshot for step 1 of 7')
    const img = byTestId(els, 'guide-viewer-image')!
    expect([img.props.width, img.props.height]).toEqual([950, 534])
    expect(byTestId(els, 'guide-viewer-area')!.props.tabIndex).toBe(0)
    expect(focused.at(-1)?.props['data-testid']).toBe('guide-viewer-area')
    expect(calls.shown).toEqual(['c3000'])
    // Fit is not 100%: a shot seen fitted is not checked.
    click(byTestId(els, 'guide-viewer-fit'))
    click(byTestId(render(viewer()), 'guide-viewer-next'))
    render(viewer())
    expect(calls.shown).toEqual(['c3000'])
  })

  it('a shot being made again keeps its place, says so and is not counted as seen', () => {
    props = { ...props, shots: [{ key: 'c3000', label: 'step 1', image: null }] }
    const els = render(viewer())
    expect(textOf(byTestId(els, 'guide-viewer-area'))).toBe('Making the screenshot…')
    expect(byTestId(els, 'guide-viewer-adjust')).toBeUndefined()
    expect(calls.shown).toEqual([])
  })

  it('Check screenshots counts the shots seen', () => {
    props = { ...props, mode: 'check', checked: 3 }
    expect(textOf(byTestId(render(viewer()), 'guide-checked'))).toBe('Checked 3 of 7')
  })

  it('a bug report shares one shot more than its steps: the title counts the steps, the Checked line the shots', () => {
    props = { ...props, mode: 'check', checked: 3, shared: 8 }
    const els = render(viewer())
    expect(textOf(els.find((e) => e.type === 'h2'))).toBe('Screenshot for step 1 of 7')
    expect(textOf(byTestId(els, 'guide-checked'))).toBe('Checked 3 of 8')
  })
})

describe('test 112: Adjust', () => {
  it('the keyboard moves the ring by 1% and, with Shift, 10%; Enter is Done and stores the crop and the ring together', () => {
    let els = render(viewer())
    click(byTestId(els, 'guide-viewer-adjust'))
    els = render(viewer())
    const ring = byTestId(els, 'guide-adjust-ring')!
    expect(ring.props['aria-label']).toBe('Ring at 50% across, 50% down')
    expect(press(ring, 'ArrowRight').prevented).toBe(true)
    els = render(viewer())
    expect(byTestId(els, 'guide-adjust-ring')!.props['aria-label']).toBe('Ring at 51% across, 50% down')
    press(byTestId(els, 'guide-adjust-ring'), 'ArrowDown', { shiftKey: true })
    els = render(viewer())
    expect(byTestId(els, 'guide-adjust-ring')!.props['aria-label']).toBe('Ring at 51% across, 60% down')
    // The crop: 1% moves, Alt resizes.
    press(byTestId(els, 'guide-adjust-crop'), 'ArrowLeft')
    els = render(viewer())
    press(byTestId(els, 'guide-adjust-crop'), 'ArrowRight', { altKey: true, shiftKey: true })
    els = render(viewer())
    expect(byTestId(els, 'guide-adjust-crop')!.props['aria-label']).toBe('Crop, 60% wide, from 29% across and 20% down')
    expect(calls.adjusted).toEqual([])
    press(byTestId(els, 'guide-adjust-ring'), 'Enter')
    expect(calls.adjusted).toEqual([['c3000', { rect: { x: 0.29, y: 0.2, w: 0.6, h: 0.5 }, ring: { x: 0.51, y: 0.6 } }]])
    // Back to the shot.
    expect(byTestId(render(viewer()), 'guide-adjust-ring')).toBeUndefined()
  })

  it('Adjust takes the focus to the crop, and Done or Cancel gives it back to the screenshot', () => {
    const at = (): unknown => focused.at(-1)?.props['data-testid']
    let els = render(viewer())
    expect(at()).toBe('guide-viewer-area')
    click(byTestId(els, 'guide-viewer-adjust'))
    els = render(viewer())
    expect(at()).toBe('guide-adjust-crop')
    // A move keeps it there; Enter is Done.
    press(byTestId(els, 'guide-adjust-crop'), 'ArrowLeft')
    els = render(viewer())
    expect(at()).toBe('guide-adjust-crop')
    press(byTestId(els, 'guide-adjust-crop'), 'Enter')
    render(viewer())
    expect(at()).toBe('guide-viewer-area')
    click(byTestId(render(viewer()), 'guide-viewer-adjust'))
    els = render(viewer())
    expect(at()).toBe('guide-adjust-crop')
    click(els.find((e) => e.type === 'button' && textOf(e) === 'Cancel'))
    render(viewer())
    expect(at()).toBe('guide-viewer-area')
  })

  it('Reset removes them (null): the shot is zoomed to the click again', () => {
    click(byTestId(render(viewer()), 'guide-viewer-adjust'))
    click(byTestId(render(viewer()), 'guide-adjust-reset'))
    expect(calls.adjusted).toEqual([['c3000', null]])
  })

  it('a crop under 5% of the screen is refused, and says so', () => {
    props = { ...props, shots: shots({ x: 0.1, y: 0.1, w: 0.03, h: 0.4 }) }
    click(byTestId(render(viewer()), 'guide-viewer-adjust'))
    const els = render(viewer())
    click(byTestId(els, 'guide-adjust-done'))
    const after = render(viewer())
    expect(calls.adjusted).toEqual([])
    expect(after.map(textOf).join(' ')).toContain('The crop is too small: at least 5% of the screen.')
    expect(byTestId(after, 'guide-adjust-crop')).toBeDefined()
  })

  it('a shot without a ring stores only the crop', () => {
    props = { ...props, index: 1 }
    click(byTestId(render(viewer()), 'guide-viewer-adjust'))
    const els = render(viewer())
    expect(byTestId(els, 'guide-adjust-ring')).toBeUndefined()
    press(byTestId(els, 'guide-adjust-crop'), 'Enter')
    expect(calls.adjusted).toEqual([['c12000', { rect: { x: 0.3, y: 0.2, w: 0.5, h: 0.5 } }]])
  })

  it('Blur an area… hands the step back to the panel', () => {
    click(byTestId(render(viewer()), 'guide-viewer-blur'))
    expect(calls.blurred).toEqual(['c3000'])
  })
})
