import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomicSync } from '../src/main/atomicWrite'

const dirs: string[] = []
const tempDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssw-atomic-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

const withRename = (renameSync: typeof fs.renameSync): Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'rmSync'> => ({
  writeFileSync: fs.writeFileSync,
  rmSync: fs.rmSync,
  renameSync
})

describe('writeFileAtomicSync', () => {
  it('replaces the file and leaves no temp file', () => {
    const dir = tempDir()
    const file = path.join(dir, 'project.json')
    fs.writeFileSync(file, 'old')
    writeFileAtomicSync(file, 'new')
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('retries a rename that fails transiently (Windows file locks)', () => {
    const dir = tempDir()
    const file = path.join(dir, 'project.json')
    let failures = 2
    writeFileAtomicSync(file, 'data', {
      delayMs: 1,
      fsImpl: withRename((a, b) => {
        if (failures-- > 0) throw errno('EBUSY')
        fs.renameSync(a, b)
      })
    })
    expect(fs.readFileSync(file, 'utf8')).toBe('data')
  })

  it('gives up on a persistent lock without touching the old file', () => {
    const dir = tempDir()
    const file = path.join(dir, 'project.json')
    fs.writeFileSync(file, 'old')
    let calls = 0
    expect(() =>
      writeFileAtomicSync(file, 'data', {
        attempts: 3,
        delayMs: 1,
        fsImpl: withRename(() => {
          calls++
          throw errno('EPERM')
        })
      })
    ).toThrow('EPERM')
    expect(calls).toBe(3)
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('throws other errors at once and cleans up the temp file', () => {
    const dir = tempDir()
    const file = path.join(dir, 'project.json')
    let calls = 0
    expect(() =>
      writeFileAtomicSync(file, 'data', {
        fsImpl: withRename(() => {
          calls++
          throw errno('EISDIR')
        })
      })
    ).toThrow('EISDIR')
    expect(calls).toBe(1)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('reports a missing folder', () => {
    expect(() => writeFileAtomicSync(path.join(tempDir(), 'gone', 'project.json'), 'x')).toThrow(/ENOENT/)
  })
})
