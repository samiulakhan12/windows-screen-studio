import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.2, §14 rule 8, §19.1 test 84): the
 * sound library's build pins a prepared file once, and unpacks archives safely. A fake encoder
 * (ffmpeg with its Opus bit rate changed) makes different bytes for the same sound: the build's
 * pins refuse them for an id that has pins and take them for a new id. A fake extractor shows that
 * only the named members come out, and that a member whose SHA-256 differs stops the build.
 */

interface Entry {
  path: string
  type: string
}
interface Tool {
  list(archive: string): Entry[]
  extract(archive: string, member: string, dir: string): string
}
interface Pin {
  file: string
  bytes: number
  sha256: string
  seconds: number
  peakAt: number
}
interface Script {
  listingProblem(entries: Entry[], wanted?: string[]): string | null
  readPreparedBlock(source: string): Record<string, unknown>
  writePreparedBlock(source: string, next: Record<string, unknown>): string
  extractMembers(archive: string, members: { path: string; bytes: number; sha256: string }[], tool: Tool, workDir: string): Map<string, string>
  prepareEffect(ff: string, effect: { id: string }, source: string, out: string, tmp: string): { pin: Pin }
}
const SCRIPT = '../scripts/build-sound-library.mjs'
const script = (await import(/* @vite-ignore */ SCRIPT)) as Script
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-sound-build-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

describe('pinned once, with a fake encoder whose output differs (test 84)', () => {
  const FF = ffmpegPath()
  /** ffmpeg, except that its Opus encodes run at 32 kb/s: the same sound, other bytes. */
  function fakeEncoder(): string {
    const dir = fs.mkdtempSync(path.join(ROOT, 'enc-'))
    const bin = path.join(dir, 'ffmpeg')
    fs.writeFileSync(
      bin,
      [
        `#!${process.execPath}`,
        "const { spawnSync } = require('node:child_process')",
        'const args = process.argv.slice(2)',
        "const i = args.indexOf('-b:a')",
        "if (args.includes('libopus') && i >= 0) args[i + 1] = '32k'",
        `const r = spawnSync(${JSON.stringify(FF)}, args, { stdio: 'inherit' })`,
        'process.exit(r.status ?? 1)'
      ].join('\n')
    )
    fs.chmodSync(bin, 0o755)
    return bin
  }

  it('stops for an id that already has pins, and fills them for a new id', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'fx-'))
    const wav = path.join(dir, 'click.wav')
    const r = spawnSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=1200:d=0.15:r=48000', '-af', 'volume=4,afade=t=out:st=0.05:d=0.1', '-ac', '1', wav])
    expect(r.status, r.stderr.toString()).toBe(0)
    const real = script.prepareEffect(FF, { id: 'x' }, wav, path.join(dir, 'sfx-x.ogg'), dir).pin
    const fake = script.prepareEffect(fakeEncoder(), { id: 'x' }, wav, path.join(dir, 'sfx-x-again.ogg'), dir).pin
    expect(fake.sha256).not.toBe(real.sha256)
    expect(sha(fs.readFileSync(path.join(dir, 'sfx-x.ogg')))).toBe(real.sha256)
    const source = `// prettier-ignore\nconst PREPARED = /* prepared:begin */ ${JSON.stringify({ x: real })} /* prepared:end */\n`
    // The id that has pins: the build stops rather than take the new bytes.
    expect(() => script.writePreparedBlock(source, { x: { ...fake, file: real.file } })).toThrow(/x is pinned already and would change/)
    // A new id: its pins are filled, and the old ones kept exactly.
    const next = script.writePreparedBlock(source, { x: real, y: { ...fake, file: 'sfx-y.ogg' } })
    expect(script.readPreparedBlock(next)).toEqual({ x: real, y: { ...fake, file: 'sfx-y.ogg' } })
  }, 60_000)
})

describe('archives are unpacked safely (test 84)', () => {
  const MEMBER = Buffer.from('the wanted member')
  const OTHER = Buffer.from('a member nobody asked for')
  const wanted = [{ path: 'Audio/click_001.ogg', bytes: MEMBER.length, sha256: sha(MEMBER) }]
  /** A stand-in for 7-Zip: lists `entries`, writes `bytes` for a member (and `extra` files beside it), records what it extracted. */
  function tool(entries: Entry[], bytes = MEMBER, extra = false): Tool & { extracted: string[] } {
    const extracted: string[] = []
    return {
      extracted,
      list: () => entries,
      extract: (_archive, member, dir) => {
        extracted.push(member)
        const out = path.join(dir, path.basename(member))
        fs.writeFileSync(out, bytes)
        if (extra) fs.writeFileSync(path.join(dir, 'stray.ogg'), OTHER)
        return out
      }
    }
  }
  const plain: Entry[] = [
    { path: 'Audio', type: 'dir' },
    { path: 'Audio/click_001.ogg', type: 'file' },
    { path: 'Audio/click_002.ogg', type: 'file' },
    { path: 'License.txt', type: 'file' }
  ]

  it('only the named members are extracted, each checked against its pin', () => {
    const t = tool(plain)
    const out = script.extractMembers('/x/kenney.zip', wanted, t, fs.mkdtempSync(path.join(ROOT, 'w-')))
    expect(t.extracted).toEqual(['Audio/click_001.ogg'])
    expect(fs.readFileSync(out.get('Audio/click_001.ogg')!).equals(MEMBER)).toBe(true)
    // A tool that writes more than the named member is refused.
    expect(() => script.extractMembers('/x/kenney.zip', wanted, tool(plain, MEMBER, true), fs.mkdtempSync(path.join(ROOT, 'w-')))).toThrow(/wrote 2 files/)
  })

  it('a member whose SHA-256 differs stops the build', () => {
    expect(() => script.extractMembers('/x/kenney.zip', wanted, tool(plain, OTHER), fs.mkdtempSync(path.join(ROOT, 'w-')))).toThrow(/is not the pinned member/)
  })

  it('a listing with an absolute path, a .. part or a link is refused before anything is extracted', () => {
    for (const bad of [
      { path: '/etc/passwd', type: 'file' },
      { path: 'C:\\Windows\\x.ogg', type: 'file' },
      { path: 'Audio/../../x.ogg', type: 'file' },
      { path: 'Audio/link.ogg', type: 'link' }
    ]) {
      const t = tool([...plain, bad])
      expect(() => script.extractMembers('/x/kenney.zip', wanted, t, fs.mkdtempSync(path.join(ROOT, 'w-'))), bad.path).toThrow(/is refused/)
      expect(t.extracted, bad.path).toEqual([])
    }
    // A wanted member missing from the listing is refused too.
    const t = tool(plain.filter((e) => e.path !== 'Audio/click_001.ogg'))
    expect(() => script.extractMembers('/x/kenney.zip', wanted, t, fs.mkdtempSync(path.join(ROOT, 'w-')))).toThrow(/is refused/)
    expect(t.extracted).toEqual([])
  })
})
