import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * scripts/build-sound-library.mjs (docs/design/editing-polish.md §10.2, §14 rule 8): archives are
 * listed before anything is extracted and one with an absolute path, a `..` part or a link is
 * refused; a prepared file is pinned once (an id's pins never change); and --check finds a changed,
 * missing, extra or misplaced file.
 */

interface Entry {
  path: string
  type: string
}
interface Script {
  listingProblem(entries: Entry[], wanted?: string[]): string | null
  parse7zzListing(text: string): Entry[]
  readPreparedBlock(source: string): Record<string, unknown>
  writePreparedBlock(source: string, next: Record<string, unknown>): string
  checkLibrary(cat: unknown, pins: Record<string, { file: string; bytes: number; sha256: string }>, dirs: { bundled: string; notice: string; evidence: string }): string[]
  loadCatalogue(): Promise<Record<string, unknown>>
  seamCheck(d: Float32Array, S: number, E: number): { seam: number; body: number }
}
const SCRIPT = '../scripts/build-sound-library.mjs'
const script = (await import(/* @vite-ignore */ SCRIPT)) as Script
const ROOT = path.join(__dirname, '..')

describe('archives are listed first and refused when unsafe', () => {
  const ok: Entry[] = [
    { path: 'Audio', type: 'dir' },
    { path: 'Audio/click_001.ogg', type: 'file' },
    { path: 'License.txt', type: 'file' }
  ]

  it('accepts a plain listing that holds the wanted members', () => {
    expect(script.listingProblem(ok, ['Audio/click_001.ogg'])).toBeNull()
  })

  it('refuses an absolute path, a .. part, a link, an unknown kind or a missing member', () => {
    expect(script.listingProblem([...ok, { path: '/etc/passwd', type: 'file' }])).toMatch(/absolute/)
    expect(script.listingProblem([...ok, { path: 'C:\\x.ogg', type: 'file' }])).toMatch(/absolute/)
    expect(script.listingProblem([...ok, { path: '\\\\server\\x', type: 'file' }])).toMatch(/absolute/)
    expect(script.listingProblem([...ok, { path: 'Audio/../../x.ogg', type: 'file' }])).toMatch(/\.\. part/)
    expect(script.listingProblem([...ok, { path: 'Audio\\..\\x.ogg', type: 'file' }])).toMatch(/\.\. part/)
    expect(script.listingProblem([...ok, { path: 'Audio/link.ogg', type: 'link' }])).toMatch(/link/)
    expect(script.listingProblem([...ok, { path: 'Audio/fifo', type: 'other' }])).toMatch(/unknown kind/)
    expect(script.listingProblem(ok, ['Audio/tick_002.ogg'])).toMatch(/no member/)
    expect(script.listingProblem(ok, ['Audio'])).toMatch(/no member/)
  })

  it("reads 7-Zip's technical listing, links included", () => {
    const text = [
      '7-Zip 24.09',
      '--',
      'Path = a.7z',
      'Type = 7z',
      '',
      '----------',
      'Path = swosh-03.flac',
      'Folder = -',
      'Size = 96738',
      'Attributes = A -rw-r--r--',
      '',
      'Path = dir',
      'Folder = +',
      'Attributes = D drwxr-xr-x',
      '',
      'Path = sneaky',
      'Folder = -',
      'Attributes = A lrwxrwxrwx',
      'Symbolic Link = /etc/passwd',
      ''
    ].join('\n')
    expect(script.parse7zzListing(text)).toEqual([
      { path: 'swosh-03.flac', type: 'file' },
      { path: 'dir', type: 'dir' },
      { path: 'sneaky', type: 'link' }
    ])
  })
})

describe('a prepared file is pinned once', () => {
  const source = `const X = 1\n// prettier-ignore\nconst PREPARED = /* prepared:begin */ {\n  "a": {"file":"a.ogg","bytes":1,"sha256":"x"}\n} /* prepared:end */\n`

  it('adds the pins of a new id and keeps the others exactly', () => {
    const next = script.writePreparedBlock(source, { a: { file: 'a.ogg', bytes: 1, sha256: 'x' }, b: { file: 'b.ogg', bytes: 2, sha256: 'y' } })
    expect(script.readPreparedBlock(next)).toEqual({ a: { file: 'a.ogg', bytes: 1, sha256: 'x' }, b: { file: 'b.ogg', bytes: 2, sha256: 'y' } })
    expect(next.startsWith('const X = 1\n')).toBe(true)
  })

  it('refuses to change or drop the pins of an id that has them', () => {
    expect(() => script.writePreparedBlock(source, { a: { file: 'a.ogg', bytes: 1, sha256: 'z' } })).toThrow(/pinned already/)
    expect(() => script.writePreparedBlock(source, {})).toThrow(/pinned already/)
  })

  it('the catalogue holds the block it writes', () => {
    const pins = script.readPreparedBlock(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'audio', 'soundLibrary.ts'), 'utf8'))
    expect(Object.keys(pins)).toHaveLength(28)
  })
})

describe('the loop seam measure', () => {
  it('finds a jump at the seam and not a smooth loop', () => {
    const E = 4800
    const S = 1200
    const smooth = new Float32Array(E * 2)
    for (let i = 0; i < E; i++) smooth[i * 2] = smooth[i * 2 + 1] = Math.sin((2 * Math.PI * (i - S)) / 400)
    const a = script.seamCheck(smooth, S, E)
    expect(a.seam).toBeLessThanOrEqual(a.body + 1e-6)
    const broken = smooth.slice()
    broken[(E - 1) * 2] = 1
    expect(script.seamCheck(broken, S, E).seam).toBeGreaterThan(0.5)
  })
})

describe('--check finds what is wrong with the committed library', () => {
  it('passes on the committed files and finds a changed, extra, misplaced or unlisted file in a copy', async () => {
    const cat = await script.loadCatalogue()
    const pins = script.readPreparedBlock(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'audio', 'soundLibrary.ts'), 'utf8')) as Record<string, { file: string; bytes: number; sha256: string }>
    const real = {
      bundled: path.join(ROOT, 'resources', 'sound-library'),
      notice: path.join(ROOT, 'resources', 'notices', '37-sound-library.txt'),
      evidence: path.join(ROOT, 'scripts', 'sound-library', 'evidence')
    }
    expect(script.checkLibrary(cat, pins, real)).toEqual([])

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-library-check-'))
    try {
      const bundled = path.join(tmp, 'sound-library')
      fs.cpSync(real.bundled, bundled, { recursive: true })
      const notice = path.join(tmp, 'notice.txt')
      fs.copyFileSync(real.notice, notice)
      const dirs = { bundled, notice, evidence: real.evidence }
      expect(script.checkLibrary(cat, pins, dirs)).toEqual([])
      // A changed byte in a bundled effect.
      const pop = path.join(bundled, pins.pop.file)
      const bytes = fs.readFileSync(pop)
      bytes[bytes.length - 1] ^= 0xff
      fs.writeFileSync(pop, bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).not.toBe(pins.pop.sha256)
      expect(script.checkLibrary(cat, pins, dirs).join('\n')).toMatch(/sfx-pop\.ogg is not its pinned file/)
      fs.copyFileSync(path.join(real.bundled, pins.pop.file), pop)
      // A bed that downloads, put in the folder; a stray file.
      fs.writeFileSync(path.join(bundled, pins['calm-old-key'].file), 'x')
      fs.writeFileSync(path.join(bundled, 'extra.ogg'), 'x')
      const problems = script.checkLibrary(cat, pins, dirs).join('\n')
      expect(problems).toMatch(/bed-calm-old-key\.ogg downloads on request/)
      expect(problems).toMatch(/extra\.ogg .* not a bundled file/)
      fs.rmSync(path.join(bundled, pins['calm-old-key'].file))
      fs.rmSync(path.join(bundled, 'extra.ogg'))
      // A notice that leaves a file out.
      fs.writeFileSync(notice, fs.readFileSync(real.notice, 'utf8').replace(pins.tick.file, 'gone'))
      expect(script.checkLibrary(cat, pins, dirs).join('\n')).toMatch(/does not list sfx-tick\.ogg/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
