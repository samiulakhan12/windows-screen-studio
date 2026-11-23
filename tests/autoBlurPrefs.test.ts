import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/*
 * Auto-blur's preference (docs/design/auto-blur.md §4.5, §17.1 test 34): prefsIpc reads and writes
 * `privacy` through readPrivacyPrefs, and an older editor-prefs.json is written back byte for byte.
 */

const h = vi.hoisted(() => ({ root: '' }))
h.root = mkdtempSync(path.join(tmpdir(), 'flown-autoblur-prefs-'))
vi.mock('electron', () => ({ app: { getPath: (name: string) => require('node:path').join(h.root, name) }, ipcMain: { handle: () => undefined, on: () => undefined } }))
const { readPrefSync, writePrefSync } = await import('../src/main/prefsIpc')
const { PREF_KEYS } = await import('../src/shared/api/prefs')
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('auto-blur contracts: preferences', () => {
  it('34. Preferences: prefsIpc sanitises privacy with readPrivacyPrefs; an older editor-prefs.json without it is written back byte for byte', () => {
    expect(PREF_KEYS).toContain('privacy')
    const file = path.join(h.root, 'userData', 'editor-prefs.json')
    mkdirSync(path.dirname(file), { recursive: true })
    const older = JSON.stringify({ shortcuts: { addZoom: 'Z' }, polish: { zoom: true }, ui: { language: 'en' } }, null, 2)
    writeFileSync(file, older)
    expect(readPrefSync('privacy')).toBeNull()
    writePrefSync('shortcuts', readPrefSync('shortcuts'))
    writePrefSync('privacy', null)
    expect(readFileSync(file, 'utf8')).toBe(older)
    // Written through the reader: limits held, unknown fields dropped.
    writePrefSync('privacy', { regions: ['BD', 'gb', 'IN'], names: ['Priya Raman', 'x'.repeat(81)], colour: 'pink', showCovers: false, junk: 1 })
    expect(readPrefSync('privacy')).toEqual({ regions: ['BD', 'IN'], names: ['Priya Raman'], showCovers: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).privacy).toEqual({ regions: ['BD', 'IN'], names: ['Priya Raman'], showCovers: false })
    writePrefSync('privacy', { kinds: ['email', 'nope'], colour: 'black' })
    expect(readPrefSync('privacy')).toEqual({ kinds: ['email'], colour: 'black' })
  })
})
