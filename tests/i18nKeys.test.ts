/**
 * Test 71 (docs/design/output-and-languages.md §14.1, §21.8 row X1, §23.1): the sentences around
 * keycaps are messages, and withShortcut, orPress, reviewHint, undoHint and zoomLevelKeysHint give
 * today's English for the default keymap and for edited ones, as do the reasons a key cannot be a
 * shortcut; in Bangla the keycaps stay Latin.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  addBinding,
  checkShortcut,
  DEFAULT_KEYMAP,
  orPress,
  removeBinding,
  reservedReason,
  reviewHint,
  shortcutLabel,
  undoHint,
  withShortcut,
  zoomLevelKeysHint,
  type Keymap
} from '../src/shared/editor/shortcuts'
import { setCatalogue } from '../src/shared/i18n/t'

afterEach(() => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }))

/* Today's helpers, as they were before their sentences became messages. */
const listPhrase = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
const old = {
  withShortcut: (text: string, a: readonly string[] | undefined): string => (a?.length ? `${text} (${shortcutLabel(a[0])})` : text),
  orPress: (text: string, a: readonly string[] | undefined): string => (a?.length ? `${text}, or press ${shortcutLabel(a[0])}` : text),
  reviewHint: (k: Keymap): string => (k.review.length ? `. Review (${shortcutLabel(k.review[0])})` : '. Review mode lists them'),
  undoHint: (k: Keymap): string => (k.undo.length ? ` · ${shortcutLabel(k.undo[0])} to undo` : ''),
  zoomLevelKeysHint(k: Keymap): string | null {
    const levels = (['zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const).flatMap((id) => k[id].slice(0, 1).map(shortcutLabel))
    const run = levels.length > 2 && levels.every((l, i) => /^\d$/.test(l) && (i === 0 || Number(l) === Number(levels[i - 1]) + 1))
    const back = k.zoomLevel0[0]
    const parts = [
      levels.length > 0 && `${run ? `${levels[0]}–${levels[levels.length - 1]}` : listPhrase(levels)} ${levels.length === 1 ? 'sets' : 'set'} its zoom level`,
      back && `${shortcutLabel(back)} pulls back`
    ].filter((p): p is string => !!p)
    return parts.length ? parts.join(', ') : null
  }
}
const RESERVED_TODAY: Record<string, string> = {
  Enter: 'Enter presses the focused button.',
  Tab: 'Tab moves between controls.',
  'Shift+Tab': 'Shift + Tab moves between controls.',
  'Alt+F4': 'Alt + F4 closes the window.',
  'Alt+Space': 'Alt + Space opens the window menu.',
  'Ctrl+Escape': 'Ctrl + Esc opens the Start menu.',
  'Ctrl+Shift+Escape': 'Ctrl + Shift + Esc opens the Task Manager.',
  'Alt+Escape': 'Alt + Esc switches to another window.',
  'Ctrl+W': 'Ctrl + W closes the window.',
  'Ctrl+R': 'Ctrl + R reloads the window.',
  'Ctrl+Shift+R': 'Ctrl + Shift + R reloads the window.',
  'Ctrl+Shift+I': 'Ctrl + Shift + I opens the developer tools.',
  F11: 'F11 switches full screen.',
  'Ctrl+0': 'Ctrl + 0 resets the window zoom.',
  'Ctrl+Plus': 'Ctrl + + zooms the window.',
  'Ctrl+=': 'Ctrl + = zooms the window.',
  'Ctrl+-': 'Ctrl + - zooms the window.'
}

/** The default keymap and edited ones: keys removed, moved and added. */
function keymaps(): Keymap[] {
  const d = DEFAULT_KEYMAP
  let noLevels = d
  for (const id of ['zoomLevel0', 'zoomLevel1', 'zoomLevel2', 'zoomLevel3', 'zoomLevel4'] as const) noLevels = removeBinding(noLevels, id, d[id][0])
  return [
    d,
    removeBinding(d, 'review', 'Shift+R'),
    addBinding(removeBinding(d, 'review', 'Shift+R'), 'review', 'Ctrl+Shift+F9'),
    removeBinding(d, 'undo', 'Ctrl+Z'),
    addBinding(removeBinding(d, 'undo', 'Ctrl+Z'), 'undo', 'Alt+Backspace'),
    removeBinding(d, 'zoomLevel3', '3'),
    removeBinding(removeBinding(d, 'zoomLevel3', '3'), 'zoomLevel0', '0'),
    addBinding(noLevels, 'zoomLevel2', 'Shift+2'),
    addBinding(addBinding(noLevels, 'zoomLevel1', 'F1'), 'zoomLevel4', 'Ctrl+Left'),
    addBinding(noLevels, 'zoomLevel0', 'Q'),
    noLevels,
    addBinding(d, 'zoomLevel2', 'Ctrl+Shift+Z')
  ]
}

describe('test 71: the shortcut sentences', () => {
  it('give today’s English for the default keymap and edited ones', () => {
    for (const k of keymaps()) {
      expect(reviewHint(k)).toBe(old.reviewHint(k))
      expect(undoHint(k)).toBe(old.undoHint(k))
      expect(zoomLevelKeysHint(k)).toBe(old.zoomLevelKeysHint(k))
      for (const a of [k.split, k.addText, k.undo, k.timelineZoomIn, [], undefined]) {
        expect(withShortcut('Split the clip at the playhead', a)).toBe(old.withShortcut('Split the clip at the playhead', a))
        expect(orPress('Double-click to add text', a)).toBe(old.orPress('Double-click to add text', a))
      }
    }
    expect(zoomLevelKeysHint(DEFAULT_KEYMAP)).toBe('1–4 set its zoom level, 0 pulls back')
    expect(withShortcut('Split the clip at the playhead', DEFAULT_KEYMAP.split)).toBe('Split the clip at the playhead (S)')
  })

  it('give today’s reasons a key cannot be a shortcut', () => {
    for (const [a, text] of Object.entries(RESERVED_TODAY)) expect(reservedReason(a), a).toBe(text)
    for (const a of ['Escape', 'Shift+Escape', 'Alt+Shift+Escape']) expect(reservedReason(a), a).toBe('Esc always cancels: it closes dialogs and clears the selection.')
    expect(reservedReason('Ctrl+Z')).toBeNull()
    expect(checkShortcut('Ctrl+Ctrl', 'undo')).toEqual({ ok: false, message: 'That key cannot be used for a shortcut.' })
    expect(checkShortcut('K', 'commandPalette')).toEqual({ ok: false, message: 'This shortcut also works while typing, so it needs Ctrl or Alt (K would type instead).' })
    expect(checkShortcut('Tab', 'undo')).toEqual({ ok: false, message: 'Tab moves between controls.' })
  })

  it('keep the keycaps Latin in Bangla', () => {
    setCatalogue({
      language: 'bn',
      messages: {
        'keys.withShortcut': '{text} ({keys})',
        'keys.orPress': '{text}, অথবা {keys} চাপুন',
        'keys.reviewHint': '। রিভিউ ({keys})',
        'keys.undoHint': ' · ফিরিয়ে নিতে {keys}',
        'keys.zoomLevels.both': '{levels} দিয়ে জুমের মাত্রা, {back} দিয়ে পিছিয়ে আসা',
        'keys.reserved.closesWindow': '{keys} উইন্ডো বন্ধ করে।'
      },
      formatLocale: 'bn-BD',
      dir: 'ltr'
    })
    const k = DEFAULT_KEYMAP
    expect(withShortcut('প্লেহেডে ক্লিপ ভাগ করুন', k.split)).toBe('প্লেহেডে ক্লিপ ভাগ করুন (S)')
    expect(orPress('লেখা যোগ করতে ডাবল-ক্লিক করুন', k.addText)).toBe('লেখা যোগ করতে ডাবল-ক্লিক করুন, অথবা T চাপুন')
    expect(reviewHint(k)).toBe('। রিভিউ (Shift + R)')
    expect(undoHint(k)).toBe(' · ফিরিয়ে নিতে Ctrl + Z')
    expect(zoomLevelKeysHint(k)).toBe('1–4 দিয়ে জুমের মাত্রা, 0 দিয়ে পিছিয়ে আসা')
    expect(reservedReason('Alt+F4')).toBe('Alt + F4 উইন্ডো বন্ধ করে।')
    // Keys without a Bangla message read in English, keycaps the same.
    expect(reservedReason('Ctrl+Plus')).toBe('Ctrl + + zooms the window.')
    expect(shortcutLabel('Ctrl+Shift+Left')).toBe('Ctrl + Shift + ←')
  })
})
