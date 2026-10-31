import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The four Captions Studio preferences (docs/design/captions-studio.md §4.6, test 35): their
 * readers, the main process storing and returning only what they read, and the saved looks the
 * window shares (useSavedLooks). Make my captions great's options and the Clean up choices are
 * part P4's readers: answered here by stand-ins that show they were used.
 */

const h = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))
h.root = mkdtempSync(path.join(tmpdir(), 'ssw-caption-prefs-'))
mkdirSync(path.join(h.root, 'userData'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(h.root, name) },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) }
}))
vi.mock('../src/shared/captions/great', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGreatOptions: (raw: unknown) => ({ read: 'great', raw })
}))
vi.mock('../src/shared/captions/cleanup', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCleanupChoices: (raw: unknown) => ({ read: 'cleanup', raw })
}))

const { readSavedLooks, readWordList, sanitizeCaptionPref, MAX_SAVED_LOOKS, MAX_WORD_LIST } = await import('../src/shared/captions/captionPrefs')
const { STUDIO_PRESETS, studioPreset } = await import('../src/shared/captions/studioPresets')
const { registerPrefsIpc } = await import('../src/main/prefsIpc')

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

const boldPop = studioPreset('bold-pop')!.look

describe('saved looks (captionPresets)', () => {
  it('keeps well-formed entries, named after their tile', () => {
    const out = readSavedLooks([{ id: 'abc123', name: '  My   style 1 ', look: boldPop }])
    expect(out).toEqual([{ id: 'abc123', name: 'My style 1', look: { ...boldPop, from: 'mine:abc123' } }])
  })

  it('drops bad ids, repeated ids, empty names and unreadable looks', () => {
    const out = readSavedLooks([
      { id: 'ABC', name: 'Upper case id', look: boldPop },
      { id: 'a'.repeat(17), name: 'Too long an id', look: boldPop },
      { id: 'ok1', name: 'First', look: boldPop },
      { id: 'ok1', name: 'Again', look: boldPop },
      { id: 'ok2', name: ' \u0007 ', look: boldPop },
      { id: 'ok3', name: 'No look', look: 'bold-pop' },
      'not an entry',
      { id: 'ok4', name: 'Kept', look: boldPop }
    ])
    expect(out.map((s) => s.id)).toEqual(['ok1', 'ok4'])
  })

  it('cuts names at 40 characters and keeps at most 50 looks', () => {
    const long = readSavedLooks([{ id: 'x1', name: 'N'.repeat(60), look: boldPop }])
    expect(long[0].name).toBe('N'.repeat(40))
    const many = readSavedLooks(Array.from({ length: 60 }, (_, i) => ({ id: `id${i}`, name: `Look ${i}`, look: boldPop })))
    expect(many).toHaveLength(MAX_SAVED_LOOKS)
    expect(many[49].id).toBe('id49')
  })

  it('reads each look like a project look (clamped, unknown fonts back to the base)', () => {
    const wild = { ...boldPop, text: { ...boldPop.text, size: 9, font: 'cat:no-such-font' } }
    const [s] = readSavedLooks([{ id: 'w', name: 'Wild', look: wild }])
    expect(s.look.text.size).toBe(0.22)
    expect(s.look.text.font).toBe('system')
  })

  it('reads its own output back the same, and anything but a list as none', () => {
    const once = readSavedLooks(STUDIO_PRESETS.slice(0, 5).map((p, i) => ({ id: `p${i}`, name: p.name, look: p.look })))
    expect(readSavedLooks(JSON.parse(JSON.stringify(once)))).toEqual(once)
    expect(readSavedLooks({ id: 'a' })).toEqual([])
    expect(readSavedLooks(null)).toEqual([])
  })
})

describe('the word list (captionWordList)', () => {
  it('trims terms and heard forms, keeps five forms of at most 40 characters', () => {
    const out = readWordList([{ term: ' Flown ', heard: ['flow in', 'flowen', 'FLOWN', 'flow in', 'a', 'b', 'c', 'd', 'e'.repeat(50)] }])
    expect(out).toEqual([{ term: 'Flown', heard: ['flow in', 'flowen', 'a', 'b', 'c'] }])
    expect(readWordList([{ term: 'Q', heard: ['x'.repeat(50)] }])[0].heard[0]).toHaveLength(40)
  })

  it('drops empty and repeated terms (ignoring case) and keeps at most 500', () => {
    const out = readWordList([{ term: '' }, { term: 'Qbexel' }, { term: 'QBEXEL', heard: ['cue bexel'] }, { heard: ['x'] }, 7, { term: 'T'.repeat(45) }])
    expect(out).toEqual([
      { term: 'Qbexel', heard: [] },
      { term: 'T'.repeat(40), heard: [] }
    ])
    expect(readWordList(Array.from({ length: 600 }, (_, i) => ({ term: `w${i}` })))).toHaveLength(MAX_WORD_LIST)
  })
})

describe('sanitizeCaptionPref', () => {
  it("reads each Captions Studio key with its reader, P4's options and choices included", () => {
    expect(sanitizeCaptionPref('captionsGreat', { emoji: true })).toEqual({ read: 'great', raw: { emoji: true } })
    expect(sanitizeCaptionPref('captionCleanup', { caps: false })).toEqual({ read: 'cleanup', raw: { caps: false } })
    expect(sanitizeCaptionPref('captionWordList', [{ term: 'Flown' }])).toEqual([{ term: 'Flown', heard: [] }])
    expect(sanitizeCaptionPref('captionPresets', [{ id: 'bad id', name: 'x', look: boldPop }])).toEqual([])
  })

  it('leaves the other keys and nothing saved alone', () => {
    const presets = [{ anything: true }]
    expect(sanitizeCaptionPref('stylePresets', presets)).toBe(presets)
    expect(sanitizeCaptionPref('polish', 'raw')).toBe('raw')
    expect(sanitizeCaptionPref('captionsGreat', null)).toBeNull()
    expect(sanitizeCaptionPref('captionWordList', undefined)).toBeNull()
  })
})

describe('the main process stores and returns what the readers give', () => {
  registerPrefsIpc()
  const set = h.handlers.get('prefs:set')!
  const get = h.handlers.get('prefs:get')!
  const file = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(h.root, 'userData', 'editor-prefs.json'), 'utf8')) as Record<string, unknown>

  it('writes saved looks and the word list read, other keys as given', () => {
    set({}, 'captionPresets', [{ id: 'good', name: 'Mine', look: boldPop }, { id: 'BAD', name: 'Dropped', look: boldPop }])
    set({}, 'captionWordList', [{ term: ' Flown ', heard: ['flow in', 3] }])
    set({}, 'stylePresets', [{ kept: 'as is' }])
    const stored = file()
    expect((stored.captionPresets as { id: string }[]).map((s) => s.id)).toEqual(['good'])
    expect(stored.captionWordList).toEqual([{ term: 'Flown', heard: ['flow in'] }])
    expect(stored.stylePresets).toEqual([{ kept: 'as is' }])
  })

  it('returns a stored value read again, and null for nothing', () => {
    set({}, 'captionsGreat', { style: false })
    expect(get({}, 'captionsGreat')).toEqual({ read: 'great', raw: { read: 'great', raw: { style: false } } })
    set({}, 'captionCleanup', null)
    expect(get({}, 'captionCleanup')).toBeNull()
    expect(get({}, 'nope')).toBeNull()
  })
})

describe('useSavedLooks', () => {
  const stored: { value: unknown; writes: unknown[] } = { value: null, writes: [] }
  vi.stubGlobal('window', {
    api: {
      getPref: async () => stored.value,
      setPref: async (_key: string, value: unknown) => {
        stored.writes.push(value)
        stored.value = value
      }
    }
  })
  const MODULE = '../src/renderer/src/editor/captionPresets'
  type Mod = {
    saveLook(name: string, look: unknown): Promise<{ id: string; name: string; look: { from: string } }>
    removeLook(id: string): Promise<void>
    restoreLook(entry: unknown, at: number): Promise<void>
    nextLookName(saved: readonly { name: string }[]): string
    resetSavedLooksForTest(): void
    SAVED_LOOKS_FULL: string
  }
  let mod: Mod
  beforeEach(async () => {
    mod = (await import(/* @vite-ignore */ MODULE)) as Mod
    mod.resetSavedLooksForTest()
    stored.value = null
    stored.writes = []
  })

  it('saves a look under a new id named after its tile, and names the next one', async () => {
    const entry = await mod.saveLook('  Launch  ', boldPop)
    expect(entry.name).toBe('Launch')
    expect(entry.id).toMatch(/^[a-z0-9]{8}$/)
    expect(entry.look.from).toBe(`mine:${entry.id}`)
    expect(stored.writes).toHaveLength(1)
    expect(mod.nextLookName([{ name: 'My style 1' }, { name: 'My style 3' }])).toBe('My style 2')
  })

  it('refuses a 51st look with the copy of §2.4', async () => {
    for (let i = 0; i < 50; i++) await mod.saveLook(`L${i}`, boldPop)
    await expect(mod.saveLook('One more', boldPop)).rejects.toThrow('You have 50 saved styles. Delete one first.')
    expect(stored.writes).toHaveLength(50)
  })

  it('deletes a look and puts it back in its place with its id (the notice’s Undo)', async () => {
    const a = await mod.saveLook('A', boldPop)
    const b = await mod.saveLook('B', boldPop)
    const c = await mod.saveLook('C', boldPop)
    await mod.removeLook(b.id)
    expect((stored.value as { id: string }[]).map((s) => s.id)).toEqual([a.id, c.id])
    await mod.restoreLook(b, 1)
    expect((stored.value as { id: string }[]).map((s) => s.id)).toEqual([a.id, b.id, c.id])
  })
})
