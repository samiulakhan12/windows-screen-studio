/**
 * How recorded clicks are described in the editor (docs/design/smarter-auto-zoom.md §8): the
 * timeline marker tooltips, the Selected click section and the Zoom › Auto zoom summary.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import type { ClickRow } from '../src/shared/engine/inputData'
import type { ClickEvent } from '../src/shared/types'

// A renderer module: loaded by path, outside the node tsconfig (as shapesPlayhead.test.ts does).
interface SelectionCopy {
  clickTooltip(row: ClickRow, deleteKeys: readonly string[], rightClicks: boolean): string
  usedClickText(click: ClickEvent, rightClicks: boolean): string
  autoZoomFoundText(found: { clicks: number; ignored: number; typing: number; marks: number; scrolls: number }, rightClicks: boolean): string
}
const SELECTION = '../src/renderer/src/editor/selection'
const { clickTooltip, usedClickText, autoZoomFoundText } = (await import(/* @vite-ignore */ SELECTION)) as SelectionCopy

const click = (t: number, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x: 0.5, y: 0.5, button })
const row = (c: ClickEvent, ignored: ClickRow['ignored'] = null): ClickRow => ({ click: c, ms: Math.round(c.t * 1000), ignored })

describe('clickTooltip', () => {
  it('names the key that ignores a click: the first Delete selection shortcut, or the Zoom panel without one', () => {
    const used = row(click(4.2))
    expect(clickTooltip(used, DEFAULT_KEYMAP.deleteSelection, false)).toBe(
      'Left click at 0:04.2 · select it and press Delete to ignore it (no zoom, click effect or sound)'
    )
    expect(clickTooltip(used, ['Backspace'], false)).toBe('Left click at 0:04.2 · select it and press Backspace to ignore it (no zoom, click effect or sound)')
    expect(clickTooltip(used, [], false)).toBe('Left click at 0:04.2 · select it to ignore it in the Zoom panel (no zoom, click effect or sound)')
  })

  it('promises no zoom only for clicks that can start one', () => {
    expect(clickTooltip(row(click(4.2, 'middle')), ['Delete'], true)).toBe('Middle click at 0:04.2 · select it and press Delete to ignore it (no click effect or sound)')
    expect(clickTooltip(row(click(4.2, 'right')), ['Delete'], false)).toBe('Right click at 0:04.2 · select it and press Delete to ignore it (no click effect or sound)')
    expect(clickTooltip(row(click(4.2, 'right')), ['Delete'], true)).toBe('Right click at 0:04.2 · select it and press Delete to ignore it (no zoom, click effect or sound)')
  })

  it('ignored clicks are used again by selecting them, whatever the keys', () => {
    expect(clickTooltip(row(click(4.2), { ms: 4200 }), [], false)).toBe('Ignored click at 0:04.2 · select it to use it again')
    expect(clickTooltip(row(click(0.3), { ms: 300, stray: 'start' }), ['Delete'], false)).toBe(
      'Ignored automatically at 0:00.3: the first moment of the recording, usually the click that focuses the app · select it to use it again'
    )
  })
})

describe('usedClickText (Selected click)', () => {
  const zooms = 'Used: it can start an automatic zoom, shows the click effect, plays the click sound and counts as activity for smart speed.'
  const noZoom = 'Used: it shows the click effect, plays the click sound and counts as activity for smart speed.'

  it('says a click can start a zoom only when auto zoom zooms for its button', () => {
    expect(usedClickText(click(4), false)).toBe(zooms)
    expect(usedClickText(click(4, 'right'), true)).toBe(zooms)
    expect(usedClickText(click(4, 'middle'), true)).toBe(noZoom)
    expect(usedClickText(click(4, 'middle'), false)).toBe(noZoom)
    expect(usedClickText(click(4, 'right'), false)).toBe(`${noZoom} Turn on Auto zoom › Right clicks to zoom for it too.`)
  })
})

describe('autoZoomFoundText (Zoom › Auto zoom summary)', () => {
  const none = { clicks: 0, ignored: 0, typing: 0, marks: 0, scrolls: 0 }

  it('counts what auto zoom can zoom for', () => {
    expect(autoZoomFoundText({ ...none, clicks: 3, ignored: 1, scrolls: 1 }, false)).toBe('3 left clicks (1 ignored) · 1 long scroll detected.')
    expect(autoZoomFoundText({ ...none, clicks: 1, typing: 2, marks: 1 }, true)).toBe('1 click · 2 typing bursts · 1 zoom mark detected.')
    expect(autoZoomFoundText(none, false)).toBe('No usable input detected.')
  })

  it('every click ignored is a sentence of its own, never "… are ignored detected"', () => {
    expect(autoZoomFoundText({ ...none, clicks: 3, ignored: 3 }, false)).toBe('All 3 left clicks are ignored.')
    expect(autoZoomFoundText({ ...none, clicks: 14, ignored: 14 }, true)).toBe('All 14 clicks are ignored.')
    expect(autoZoomFoundText({ ...none, clicks: 1, ignored: 1, typing: 1 }, false)).toBe('The only left click is ignored. 1 typing burst detected.')
    expect(autoZoomFoundText({ ...none, clicks: 2, ignored: 2, marks: 1, scrolls: 2 }, false)).toBe('All 2 left clicks are ignored. 1 zoom mark · 2 long scrolls detected.')
  })
})
