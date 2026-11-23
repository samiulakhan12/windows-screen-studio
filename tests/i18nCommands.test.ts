/**
 * Test 70 (docs/design/output-and-languages.md §21.8 row X1, §23.1): the command palette finds a
 * command by its title in the UI language, by its English title and by its English keywords,
 * comparing NFC forms (য় typed either way); COMMAND_CATEGORIES stays the same list of ids, and the
 * categories' English names are today's; Language… exists only while Settings has a Language
 * section.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  categoryLabel,
  COMMAND_CATEGORIES,
  COMMANDS,
  commandInfo,
  commandTitle,
  listedCommands,
  PALETTE_COMMANDS,
  paletteCommands,
  searchCommands,
  WAITING_COMMANDS,
  type CommandInfo
} from '../src/shared/editor/commands'
import commandsEn from '../src/shared/i18n/messages/en/commands.json'
import { setCatalogue } from '../src/shared/i18n/t'

const english = (): void => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })
afterEach(english)

/** A Bangla catalogue for a few commands (fixture text, not a translation anyone approved). */
const BANGLA: Record<string, string> = {
  // "সময়রেখা" with য় as য + ় (NFC: U+09DF does not compose).
  'commands.title.toggleWaveform': 'সময়রেখায় শব্দের তরঙ্গ'.normalize('NFC'),
  'commands.title.split': 'প্লেহেডে ক্লিপ ভাগ করুন',
  'commands.title.addChapter': 'প্লেহেডে অধ্যায় যোগ করুন',
  'commands.category.timeline': 'সময়রেখা'.normalize('NFC'),
  'commands.category.edit': 'সম্পাদনা'
}
const bangla = (): void => setCatalogue({ language: 'bn', messages: BANGLA, formatLocale: 'bn-BD', dir: 'ltr' })
const ids = (query: string, commands: readonly CommandInfo[] = PALETTE_COMMANDS): string[] => searchCommands(commands, query).map((r) => r.command.id)

describe('test 70: the palette in the UI language and in English', () => {
  it('keeps the categories as the same ids, with today’s English names', () => {
    expect(COMMAND_CATEGORIES).toEqual(['Playback', 'Edit', 'Add', 'Zoom', 'Effects', 'Camera', 'Captions', 'Panels', 'Timeline', 'General', 'Publish'])
    for (const c of COMMAND_CATEGORIES) expect(categoryLabel(c)).toBe(c)
    for (const c of COMMANDS) expect(COMMAND_CATEGORIES).toContain(c.category)
  })

  it('gives every command its English title from the catalogue, shown as it is in English', () => {
    for (const c of COMMANDS) {
      expect(c.title, c.id).toBe((commandsEn as Record<string, string>)[`title.${c.id}`])
      expect(commandTitle(c), c.id).toBe(c.title)
      expect(commandTitle(c.id), c.id).toBe(c.title)
    }
    // Every title in the catalogue belongs to a command.
    const titles = Object.keys(commandsEn).filter((k) => k.startsWith('title.'))
    expect(titles.sort()).toEqual(COMMANDS.map((c) => `title.${c.id}`).sort())
    expect(commandInfo('undo').title).toBe('Undo')
  })

  it('in English, ranks exactly as by the English titles alone', () => {
    for (const q of ['', 'spl', 'zoom', 'export', 'cap', 'add text', 'timeline', 'Playback', 'mute', 'xyz']) {
      expect(searchCommands(PALETTE_COMMANDS, q, ['split'])).toEqual(searchCommands(PALETTE_COMMANDS, q, ['split'], (c) => c.title))
    }
  })

  it('finds a command by its title in the UI language, with that title’s letters highlighted', () => {
    bangla()
    expect(commandTitle('split')).toBe(BANGLA['commands.title.split'])
    const first = searchCommands(PALETTE_COMMANDS, 'ভাগ')[0]
    expect(first.command.id).toBe('split')
    const shown = commandTitle(first.command)
    expect(first.indices.map((i) => shown[i]).join('')).toBe('ভাগ')
  })

  it('finds it by its English title and its English keywords in another UI language, without highlights', () => {
    bangla()
    const byTitle = searchCommands(PALETTE_COMMANDS, 'split clip')
    expect(byTitle[0].command.id).toBe('split')
    expect(byTitle[0].indices).toEqual([])
    expect(ids('razor')).toContain('split')
    expect(ids('bookmark')).toContain('addChapter')
    // A category by its name in the UI language and by its English id.
    expect(ids('সম্পাদনা')).toContain('undo')
    expect(ids('edit')).toContain('undo')
  })

  it('compares NFC forms: য় typed as one character or as য and ় finds the same command', () => {
    bangla()
    const precomposed = 'য়' // য়
    const parts = 'য়' // য + ়
    const a = ids(`সম${precomposed}রেখায়`)
    const b = ids(`সম${parts}রেখায়`)
    expect(a[0]).toBe('toggleWaveform')
    expect(b).toEqual(a)
    // The category's UI name, typed either way, finds the timeline's commands.
    expect(ids(`সম${precomposed}`)).toEqual(ids(`সম${parts}`))
    expect(ids(`সম${precomposed}`)).toContain('timelineFit')
  })

  it('lists Language… only while Settings has a Language section', () => {
    expect(PALETTE_COMMANDS.map((c) => c.id)).not.toContain('language')
    expect(paletteCommands(false)).toBe(PALETTE_COMMANDS)
    expect(paletteCommands(true).map((c) => c.id)).toEqual([...PALETTE_COMMANDS.map((c) => c.id), 'language'])
    expect(listedCommands(false).map((c) => c.id)).not.toContain('language')
    // Every command but those waiting for their part (auto-blur §12.3).
    expect(listedCommands(true)).toEqual(COMMANDS.filter((c) => !WAITING_COMMANDS.includes(c.id)))
    expect(ids('language', paletteCommands(false))).not.toContain('language')
    expect(ids('ভাষা', paletteCommands(true))[0]).toBe('language')
  })
})
