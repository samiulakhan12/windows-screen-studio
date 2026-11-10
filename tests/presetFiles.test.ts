import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { UserExportPreset } from '../src/shared/render/userPresets'

/*
 * `.flownpreset` files in main (docs/design/output-and-languages.md §4.5, §18.2, part P5): main writes
 * the text itself from presets, reads it back before writing, and reads at most 64 KB of a file.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {}
}))

const { openPresetFile, presetFileFor, savePresetFile, withPresetExtension } = await import('../src/main/presetFiles')
const { presetFileText, readPresetFile } = await import('../src/shared/render/userPresets')
const { t } = await import('../src/shared/i18n/t')

const root = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ssw-preset-files-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const options = { format: 'mov', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', codec: 'cineform' } as const
const presets: UserExportPreset[] = [
  { id: 'user:0123456789ab', name: 'Client review', options: { ...options }, bundle: { srt: false, vtt: false, chapters: false, thumbnail: false, description: false, perChapter: false, stems: true }, saved: 5 },
  { id: 'user:0123456789ac', name: 'ভিডিও', options: { ...options, format: 'mp4', codec: undefined }, saved: 6 }
]
for (const p of presets) if (p.options.codec === undefined) delete p.options.codec

interface Asked {
  save: Electron.SaveDialogOptions[]
  open: Electron.OpenDialogOptions[]
}
function deps(answer: { save?: string | null; open?: string | null }, folder = root): { deps: Parameters<typeof savePresetFile>[2]; asked: Asked } {
  const asked: Asked = { save: [], open: [] }
  return {
    asked,
    deps: {
      showSaveDialog: async (o) => (asked.save.push(o), answer.save ? { canceled: false, filePath: answer.save } : { canceled: true }),
      showOpenDialog: async (o) => (asked.open.push(o), answer.open ? { canceled: false, filePaths: [answer.open] } : { canceled: true, filePaths: [] }),
      folder: () => folder
    }
  }
}

describe('the text main writes', () => {
  it('is presetFileText of the presets as the stored-preset reader keeps them, and reads back the same', () => {
    const text = presetFileFor(presets)!
    expect(text).toBe(presetFileText(presets))
    expect(readPresetFile(text)!.presets.map((p) => p.name)).toEqual(['Client review', 'ভিডিও'])
  })

  it('refuses what the renderer could use to write other text: no presets, too many, wrong shapes, unknown ids', () => {
    expect(presetFileFor([])).toBeNull()
    expect(presetFileFor('{"flown":"export-presets"}')).toBeNull()
    expect(presetFileFor([{ name: 'x', options }])).toBeNull()
    expect(presetFileFor([presets[0], { ...presets[1], id: 'youtube-1080' }])).toBeNull()
    expect(presetFileFor(Array.from({ length: 51 }, (_, i) => ({ ...presets[0], id: `user:${i.toString(16).padStart(12, '0')}` })))).toBeNull()
    // Only known fields reach the file, cleaned: a name's bidi override is dropped, a stray field never written.
    const text = presetFileFor([{ ...presets[0], name: 'Evil\u202e', options: { ...options, path: 'C:\\x' }, script: 'alert(1)' }])!
    expect(text).not.toMatch(/"path"|"script"|alert|\u202e/)
  })

  it('always names the file .flownpreset', () => {
    expect(withPresetExtension('C:\\a\\b')).toBe('C:\\a\\b.flownpreset')
    expect(withPresetExtension('C:\\a\\b.FlownPreset')).toBe('C:\\a\\b.FlownPreset')
    expect(withPresetExtension('C:\\a\\b.txt')).toBe('C:\\a\\b.txt.flownpreset')
  })
})

describe('export:savePresetFile', () => {
  it('asks where with a safe default name, writes the file and gives its path', async () => {
    const target = path.join(root, 'mine')
    const { deps: d, asked } = deps({ save: target })
    expect(await savePresetFile('Client: review?', presets, d)).toBe(`${target}.flownpreset`)
    expect(readFileSync(`${target}.flownpreset`, 'utf8')).toBe(presetFileText(presets))
    expect(asked.save[0].defaultPath).toBe(path.join(root, 'Client- review-.flownpreset'))
    expect(asked.save[0].title).toBe(t('main.presetFile.saveTitle'))
    expect(asked.save[0].filters).toEqual([{ name: t('main.presetFile.filter'), extensions: ['flownpreset'] }])
    // A name that tries to leave the folder stays a file name inside it.
    await savePresetFile('..\\..\\Windows\\x', presets, d)
    expect(path.dirname(asked.save[1].defaultPath!)).toBe(root)
    // No temporary file is left behind.
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('resolves null when the dialog is cancelled, and refuses presets it cannot write before asking', async () => {
    const { deps: d, asked } = deps({ save: null })
    expect(await savePresetFile('A', presets, d)).toBeNull()
    await expect(savePresetFile('A', [{ junk: true }], d)).rejects.toThrow(t('errors.presetFile.notSaved'))
    expect(asked.save).toHaveLength(1)
  })

  it('says the presets could not be saved when the folder cannot be written', async () => {
    const { deps: d } = deps({ save: path.join(root, 'missing-folder', 'x.flownpreset') })
    await expect(savePresetFile('A', presets, d)).rejects.toThrow(t('errors.presetFile.notSaved'))
  })
})

describe('export:openPresetFile', () => {
  const file = (name: string, content: string | Buffer): string => {
    const p = path.join(root, name)
    writeFileSync(p, content)
    return p
  }

  it('reads a preset file through readPresetFile', async () => {
    const p = file('ok.flownpreset', `\ufeff${presetFileText(presets)}`)
    const { deps: d, asked } = deps({ open: p })
    const read = await openPresetFile(d)
    expect(read).toEqual(readPresetFile(presetFileText(presets)))
    expect(asked.open[0].properties).toEqual(['openFile'])
    expect(asked.open[0].filters).toEqual([{ name: t('main.presetFile.filter'), extensions: ['flownpreset'] }])
  })

  it('reports ProRes presets as the CineForm they export as', async () => {
    const prores = JSON.stringify({ flown: 'export-presets', version: 1, presets: [{ name: 'A', options: { ...options, codec: 'prores-422' } }, { name: 'B', options: { ...options, codec: 'prores-4444', alpha: 'overlays' } }] })
    const read = (await openPresetFile(deps({ open: file('prores.flownpreset', prores) }).deps)) as { changed: unknown[] }
    expect(read.changed).toEqual([
      { from: 'prores-422', to: 'cineform', count: 1 },
      { from: 'prores-4444', to: 'cineform', count: 1 }
    ])
  })

  it('refuses a file over 64 KB without reading past the limit, and anything that is not a preset file', async () => {
    expect(await openPresetFile(deps({ open: file('big.flownpreset', `${presetFileText(presets)}${' '.repeat(70 * 1024)}`) }).deps)).toEqual({ refused: 'too-large' })
    expect(await openPresetFile(deps({ open: file('exact.flownpreset', `{"flown":"export-presets","version":1,"presets":[]}${' '.repeat(65536 - 51)}`) }).deps)).toEqual({ presets: [], skipped: 0, changed: [] })
    expect(await openPresetFile(deps({ open: file('latin1.flownpreset', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])) }).deps)).toEqual({ refused: 'unreadable' })
    // A preset file in every other way, with one byte that is not UTF-8 in a name: never read as U+FFFD.
    const [head, tail] = presetFileText([presets[0]]).split('Client review')
    expect(await openPresetFile(deps({ open: file('one-bad-byte.flownpreset', Buffer.concat([Buffer.from(`${head}Client`), Buffer.from([0xe9]), Buffer.from(` review${tail}`)])) }).deps)).toEqual({ refused: 'unreadable' })
    expect(await openPresetFile(deps({ open: file('junk.flownpreset', 'not json') }).deps)).toEqual({ refused: 'unreadable' })
    expect(await openPresetFile(deps({ open: path.join(root, 'nope.flownpreset') }).deps)).toEqual({ refused: 'unreadable' })
    const dir = path.join(root, 'folder.flownpreset')
    mkdirSync(dir)
    expect(await openPresetFile(deps({ open: dir }).deps)).toEqual({ refused: 'unreadable' })
  })

  it('resolves null when the dialog is cancelled', async () => {
    expect(await openPresetFile(deps({ open: null }).deps)).toBeNull()
  })
})
