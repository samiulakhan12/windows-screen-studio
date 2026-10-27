import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BANGLA_MODEL, modelUrl, speechModel } from '../src/shared/speech/catalog'
import { modelArgs } from '../src/shared/speech/protocol'

/*
 * The opt-in benchmark of the Bangla model (scripts/bench-bangla.mjs, docs/design/offline-captions.md
 * §14): its copy of the pin and the arguments it passes match the app's, its fixture is the
 * committed one, and its scoring treats Bangla text as the design says.
 */

const ROOT = path.resolve(__dirname, '..')
const bench = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'bench-bangla.mjs')).href)) as {
  BANGLA_PIN: Record<string, unknown>
  FIXTURE: string
  TRANSCRIPT: string
  benchArgs(o: { modelDir: string; audio: string; vadModel?: string; threads: number }): string[]
  placeModel(model: string, dir: string, ops?: Record<'linkSync' | 'symlinkSync' | 'copyFileSync', (from: string, to: string) => void>): string
}
const score = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'banglaScore.mjs')).href)) as {
  normaliseBangla(text: string): string
  editDistance(a: readonly unknown[], b: readonly unknown[]): number
  scoreBangla(reference: string, hypothesis: string): { wer: number; cer: number; words: number; wordEdits: number }
}

describe('the Bangla model benchmark', () => {
  it('pins the model as the catalog does', () => {
    const bn = speechModel(BANGLA_MODEL)!
    expect(bench.BANGLA_PIN).toEqual({
      id: bn.id,
      file: bn.file,
      bytes: bn.bytes,
      sha256: bn.sha256,
      url: modelUrl(bn),
      language: bn.language,
      maxChunkSeconds: bn.maxChunkSeconds,
      noTimestamps: bn.noTimestamps
    })
  })

  it('runs the helper with the language and the arguments the app passes for the model', () => {
    const bn = speechModel(BANGLA_MODEL)!
    const args = bench.benchArgs({ modelDir: '/m', audio: '/a.wav', vadModel: '/v.bin', threads: 4 })
    expect(args).toEqual(['transcribe', '--model-dir', '/m', '--model', bn.file, '--audio', '/a.wav', '--vad-model', '/v.bin', '--lang', bn.language!, ...modelArgs(bn), '--threads', '4'])
    expect(modelArgs(bn)).toEqual(['--max-chunk', '20', '--no-timestamps'])
  })

  it('places the model without a symbolic link first: a plain Windows account may not make one (EPERM)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-bench-place-'))
    try {
      const model = path.join(dir, 'any-name.bin')
      writeFileSync(model, 'model bytes')
      const into = mkdtempSync(path.join(dir, 'tmp-'))
      // A hard link on the same volume: the same file, no privilege, no copy.
      expect(bench.placeModel(model, into)).toBe('hard link')
      expect(statSync(path.join(into, bench.BANGLA_PIN.file as string)).ino).toBe(statSync(model).ino)
      // Another drive (EXDEV) and no right to make symbolic links (EPERM, Windows without Developer Mode): a copy.
      const refuse = (code: string) => (): never => {
        throw Object.assign(new Error(code), { code })
      }
      const tried: string[] = []
      const copyTo = mkdtempSync(path.join(dir, 'copy-'))
      const how = bench.placeModel(model, copyTo, {
        linkSync: () => (tried.push('link'), refuse('EXDEV')()),
        symlinkSync: () => (tried.push('symlink'), refuse('EPERM')()),
        copyFileSync: (from, to) => (tried.push('copy'), writeFileSync(to, readFileSync(from)))
      })
      expect([how, tried]).toEqual(['copy', ['link', 'symlink', 'copy']])
      expect(readFileSync(path.join(copyTo, bench.BANGLA_PIN.file as string), 'utf8')).toBe('model bytes')
      // Nothing works: one clear message, never an uncaught EPERM.
      expect(() => bench.placeModel(model, copyTo, { linkSync: refuse('EXDEV'), symlinkSync: refuse('EPERM'), copyFileSync: refuse('ENOSPC') })).toThrow(
        /^could not put the model in .* \(hard link: EXDEV; symbolic link: EPERM; copy: ENOSPC\)\. Free some disk space, or pass --model a file on the same drive as /
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a wrong model in one line, without a stack trace', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-bench-wrong-'))
    try {
      const model = path.join(dir, 'wrong.bin')
      writeFileSync(model, 'not the model')
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bench-bangla.mjs'), '--model', model], { encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stderr.trim()).toBe(`bench-bangla: ${model} is 13 bytes, the pin is ${bench.BANGLA_PIN.bytes}`)
      expect(existsSync(model)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('transcribes the committed fixture against its committed transcript', () => {
    const readme = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'speech', 'README.md'), 'utf8')
    const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
    expect(path.relative(ROOT, bench.FIXTURE)).toBe(path.join('tests', 'fixtures', 'speech', 'bn-fleurs-blog-18s.flac'))
    expect(readme).toContain(sha(bench.FIXTURE))
    expect(readme).toContain(sha(bench.TRANSCRIPT))
    expect(score.normaliseBangla(readFileSync(bench.TRANSCRIPT, 'utf8')).split(' ')).toHaveLength(26)
  })
})

describe('Bangla scoring', () => {
  it('keeps vowel signs and marks inside words and drops punctuation, the dari included', () => {
    expect(score.normaliseBangla('ব্লগ ছাত্রছাত্রীদের লেখার উন্নতিও করতে পারে। যদিও, কিন্তু!')).toBe('ব্লগ ছাত্রছাত্রীদের লেখার উন্নতিও করতে পারে যদিও কিন্তু')
    expect(score.normaliseBangla('“চাঁদ” — সংখ্যা: দুঃখ॥')).toBe('চাঁদ সংখ্যা দুঃখ')
  })

  it('reads the two ways of writing the same text as one (NFC, zero-width, khanda ta)', () => {
    expect(score.normaliseBangla('কোন')).toBe('কোন')
    expect(score.normaliseBangla('কি‌ছু')).toBe('কিছু')
    expect(score.normaliseBangla('হঠাত্‍')).toBe('হঠাৎ')
    expect(score.normaliseBangla('অাম')).toBe('আম')
  })

  it('writes digits as ASCII, keeping a decimal point and dropping a thousands comma', () => {
    expect(score.normaliseBangla('১,০০০ টাকা ৩.৫ শতাংশ')).toBe('1000 টাকা 3.5 শতাংশ')
    expect(score.normaliseBangla('Hello, WORLD.')).toBe('hello world')
  })

  it('WER over words, CER over code points with spaces', () => {
    expect(score.editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2)
    const ref = 'আমি বাংলায় কথা বলি।'
    expect(score.scoreBangla(ref, 'আমি বাংলায় কথা বলি')).toMatchObject({ wer: 0, cer: 0, words: 4 })
    expect(score.scoreBangla(ref, 'আমি বাংলা কথা বলি')).toMatchObject({ wer: 0.25, wordEdits: 1 })
    expect(score.scoreBangla(ref, '').wer).toBe(1)
    expect(score.scoreBangla(ref, 'আমি বাংলা কথা বলি').cer).toBeCloseTo(2 / [...'আমি বাংলায় কথা বলি'].length, 6)
  })
})
