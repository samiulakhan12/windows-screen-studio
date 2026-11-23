import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { READER_FILES } from '../src/shared/privacy/readerCatalog'

/*
 * Building and shipping the text reader helper (docs/design/auto-blur.md §5.12, §10.5, §16.2;
 * §17.1 tests 85-89): the detector's numbers in the helper, its imports, budget and test-only
 * strings, the release check of the mirror, the notices, and the Windows Error Reporting value.
 */

const ROOT = path.resolve(__dirname, '..')
const packaging = require('../scripts/lib/packaging.cjs') as {
  OCR_IMPORTS: string[]
  OCR_BUDGET: { compressed: number; installed: number }
  ocrHelper(): { from: string; to: string }
  ocrHelperStatus(rootDir?: string): { from: string; to: string; bundle: boolean; present: boolean; reason?: string }
  ocrHelperProblems(file: string, opts?: { signedBuild?: boolean }): string[]
  readerReleaseProblems(mirror: unknown, release?: boolean): string[]
  speechResources(rootDir?: string): { from: string; to: string; filter: string[] }[]
}
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8')

const dirs: string[] = []
const tmpDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'flown-ocr-pack-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A minimal PE32+ image importing `dlls`, `size` bytes long (random or zero padding), holding `text`. */
function fakeExe(dlls: string[], opts: { size?: number; padding?: 'zero' | 'random'; text?: string; signed?: boolean } = {}): Buffer {
  const rva = 0x1000
  const raw = 0x200
  const descriptors = 20 * (dlls.length + 1)
  let namesAt = descriptors
  const section = Buffer.alloc(namesAt + dlls.reduce((n, d) => n + d.length + 1, 0) + 16)
  dlls.forEach((d, i) => {
    section.writeUInt32LE(rva + namesAt, i * 20 + 12)
    section.writeUInt32LE(rva + 0x10, i * 20 + 16)
    section.write(d, namesAt, 'latin1')
    namesAt += d.length + 1
  })
  const rawSize = (section.length + 0x1ff) & ~0x1ff
  const cert = opts.signed ? 64 : 0
  const body = Math.max(raw + rawSize + 64, (opts.size ?? 0) - cert)
  const buf = Buffer.alloc(body + cert)
  if (opts.padding === 'random') randomBytes(body - raw - rawSize).copy(buf, raw + rawSize)
  if (opts.text) buf.write(opts.text, raw + rawSize, 'latin1')
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x40, 0x3c)
  buf.write('PE\0\0', 0x40, 'latin1')
  buf.writeUInt16LE(0x8664, 0x44)
  buf.writeUInt16LE(1, 0x46)
  buf.writeUInt16LE(240, 0x54)
  const opt = 0x58
  buf.writeUInt16LE(0x20b, opt)
  buf.writeUInt32LE(16, opt + 108)
  buf.writeUInt32LE(rva, opt + 112 + 1 * 8)
  buf.writeUInt32LE(descriptors, opt + 112 + 1 * 8 + 4)
  if (cert) {
    buf.writeUInt32LE(body, opt + 112 + 4 * 8)
    buf.writeUInt32LE(cert, opt + 112 + 4 * 8 + 4)
  }
  const sec = opt + 240
  buf.write('.idata', sec, 'latin1')
  buf.writeUInt32LE(section.length, sec + 8)
  buf.writeUInt32LE(rva, sec + 12)
  buf.writeUInt32LE(rawSize, sec + 16)
  buf.writeUInt32LE(raw, sec + 20)
  section.copy(buf, raw)
  return buf
}

const RUST = ['KERNEL32.dll', 'ntdll.dll', 'msvcrt.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll']
const WINRT = ['combase.dll', 'oleaut32.dll', 'api-ms-win-core-winrt-l1-1-0.dll']
const exeFile = (buf: Buffer): string => {
  const f = path.join(tmpDir(), 'ssw-ocr.exe')
  writeFileSync(f, buf)
  return f
}

describe('auto-blur P2: building and shipping the reader', () => {
  it("85. The helper's detector constants (native/ocr/src/read.rs, read as text) equal the tiny detector's pinned inference.yml values in reader-models.json; its compiled pins equal readerCatalog.ts's", () => {
    const pins = JSON.parse(read('scripts/privacy/reader-models.json')) as { models: { tiny_det: { post: Record<string, number>; config: { sha256: string } } } }
    const post = pins.models.tiny_det.post
    const rs = read('native/ocr/src/read.rs')
    const constant = (name: string): number => Number(new RegExp(`pub const ${name}: \\w+ = ([0-9.]+);`).exec(rs)![1])
    expect(constant('DET_THRESH')).toBe(post.thresh)
    expect(constant('DET_BOX_THRESH')).toBe(post.box_thresh)
    expect(constant('DET_UNCLIP_RATIO')).toBe(post.unclip_ratio)
    expect(constant('DET_MAX_CANDIDATES')).toBe(post.max_candidates)
    expect(post).toEqual({ thresh: 0.2, box_thresh: 0.4, unclip_ratio: 1.4, max_candidates: 3000 })
    // The helper compiles in the same pins main sends (§10.2): both must agree.
    const models = read('native/ocr/src/models.rs')
    for (const f of READER_FILES) {
      const m = new RegExp(`file: "${f.file.replace(/[.]/g, '\\.')}", bytes: ([0-9_]+), sha256: "([0-9a-f]{64})"`).exec(models)
      expect(m, f.file).not.toBeNull()
      expect(Number(m![1].replace(/_/g, ''))).toBe(f.bytes)
      expect(m![2]).toBe(f.sha256)
    }
  })

  it('86. ocrHelperProblems: a fixture importing wer.dll fails the allow-list and one importing the WinRT three passes; the budget is measured at brotli 11; speechResources carries ssw-ocr.exe; a build without it says so', () => {
    expect(packaging.OCR_IMPORTS).toEqual([...RUST, ...WINRT])
    expect(packaging.ocrHelperProblems(exeFile(fakeExe([...RUST, ...WINRT])))).toEqual([])
    expect(packaging.ocrHelperProblems(exeFile(fakeExe([...RUST, 'wer.dll'])))).toEqual([`imports wer.dll; only ${packaging.OCR_IMPORTS.join(', ')} are allowed`])
    // The budget: installed bytes, and brotli quality 11 with a 16 MB window.
    expect(packaging.OCR_BUDGET).toEqual({ compressed: 3.9e6, installed: 16e6 })
    expect(packaging.ocrHelperProblems(exeFile(fakeExe(RUST, { size: 16e6 + 1 })))).toEqual([`is ${16e6 + 1} B installed, over its budget of 16000000 B`])
    expect(packaging.ocrHelperProblems(exeFile(fakeExe(RUST, { size: 3.95e6, padding: 'random' }))).join('; ')).toMatch(/B compressed, over its budget of 3900000 B$/)
    expect(packaging.ocrHelperProblems(exeFile(fakeExe(RUST, { size: 3.95e6, padding: 'zero' })))).toEqual([])
    expect(packaging.ocrHelperProblems(exeFile(fakeExe(RUST)), { signedBuild: true })).toEqual(['is not signed in a signed build'])
    // It rides the speech helpers' directory-form entry, so it is signed with them.
    const root = tmpDir()
    expect(packaging.ocrHelperStatus(root)).toEqual({ from: 'native/bin/ssw-ocr.exe', to: 'native/ssw-ocr.exe', bundle: false, present: false })
    expect(packaging.speechResources(root).some((r) => r.filter.includes('ssw-ocr.exe'))).toBe(false)
    mkdirSync(path.join(root, 'native', 'bin'), { recursive: true })
    writeFileSync(path.join(root, 'native', 'bin', 'ssw-ocr.exe'), fakeExe([...RUST, ...WINRT]))
    expect(packaging.speechResources(root)[0]).toEqual({ from: 'native/bin', to: 'native', filter: ['ssw-ocr.exe'] })
    // The app looks for it where the entry puts it.
    expect(read('src/main/privacy/readerHelper.ts')).toContain("path.join(process.resourcesPath, 'native', 'ssw-ocr.exe')")
    // A build without it says so, in build-native and verify-dist.
    expect(read('scripts/verify-dist.mjs')).toContain('Find private info is not part of this build')
    expect(read('scripts/build-native.mjs')).toContain("const OCR_CONSEQUENCE = 'Find private info will be unavailable (the text reader cannot run).'")
  })

  it('87. verify-dist §4d: a release build with READER_MIRROR null fails; a binary containing readImage fails; OCR_IMPORTS is checked', () => {
    expect(packaging.readerReleaseProblems(null, true)).toEqual(['READER_MIRROR in src/shared/privacy/readerCatalog.ts is null: the text reader has no Qbexel mirror yet (a release blocker, decision 10)'])
    expect(packaging.readerReleaseProblems({ repo: 'Qbexel/flown-reader', commit: 'abc' }, true)).toEqual([])
    expect(packaging.readerReleaseProblems(null, false)).toEqual([])
    expect(packaging.ocrHelperProblems(exeFile(fakeExe(RUST, { text: 'op readImage png' })))).toEqual(['is the test build (it holds readImage)'])
    const verify = read('scripts/verify-dist.mjs')
    expect(verify).toContain('ocrHelperProblems(out, { signedBuild })')
    expect(verify).toContain("await import(new URL('../src/shared/privacy/readerCatalog.ts', import.meta.url).href)")
    expect(verify).toContain('readerReleaseProblems(READER_MIRROR)')
    // The release check reads the real catalogue: the mirror is still the owner's to create.
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', "const { READER_MIRROR } = await import(process.argv[1]); console.log(JSON.stringify(READER_MIRROR))", path.join(ROOT, 'src/shared/privacy/readerCatalog.ts')], { encoding: 'utf8' })
    expect(out.stdout.trim()).toBe('null')
    // The Windows build is made without the test feature, and checked before it is copied out.
    const build = read('scripts/build-native.mjs')
    expect(build).toContain("['build', '--release', '--locked', ...args, '--manifest-path', path.join(ocrCrate, 'Cargo.toml')]")
    expect(build).not.toMatch(/--features[^\n]*fixture/)
    expect(build).toContain('const problems = ocrHelperProblems(built)')
  })

  it('88. Notices: CRATES holds native/ocr/Cargo.toml, RUST_TITLE names ssw-ocr.exe, 41-paddleocr-models.txt exists with the Apache-2.0 text, and the notices are up to date', () => {
    const notices = read('scripts/notices.mjs')
    expect(notices).toMatch(/const CRATES = \[[^\]]*'native\/ocr\/Cargo\.toml'/)
    expect(notices).toMatch(/RUST_TITLE = '[^']*ssw-ocr\.exe/)
    const file = 'resources/notices/41-paddleocr-models.txt'
    expect(existsSync(path.join(ROOT, file))).toBe(true)
    const text = read(file)
    expect(text).toMatch(/^PaddlePaddle PP-OCRv6 text models/)
    expect(text).toContain('Downloaded when you ask for it')
    for (const f of READER_FILES) {
      expect(text).toContain(f.repo)
      expect(text).toContain(f.commit)
      expect(text).toContain(f.sha256)
    }
    // The licence is PaddleOCR's LICENSE, byte for byte (11,376 bytes, SHA-256 3840c5c0…).
    const licence = text.slice(text.indexOf('                                 Apache License'))
    expect(createHash('sha256').update(licence).digest('hex')).toBe('3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e')
    const shipped = read('resources/THIRD_PARTY_NOTICES.txt')
    expect(shipped).toContain('PaddlePaddle PP-OCRv6 text models')
    for (const name of ['tract-onnx 0.23.10', 'rqrr 0.11.0', 'sha2 ']) expect(shipped, name).toContain(name)
    const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
    if (!cargo.error && cargo.status === 0) {
      const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'notices.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
      expect(check.status, check.stderr).toBe(0)
    }
  }, 180_000)

  it('89. installer.nsh: customInstall writes the WER value under HKLM for an install for all users and under HKCU for one user, and customUnInstall deletes it from the same place; the helper calls WerSetFlags with WER_FAULT_REPORTING_FLAG_NOHEAP and SetUnhandledExceptionFilter', () => {
    const nsh = read('build/installer.nsh')
    const macro = (name: string): string => new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(nsh)![1]
    expect(nsh).toContain('!define FLOWN_WER_EXCLUDED "Microsoft\\Windows\\Windows Error Reporting\\ExcludedApplications"')
    expect(nsh).toContain('!define FLOWN_WER_HELPER "ssw-ocr.exe"')
    const install = macro('customInstall')
    expect(install).toMatch(/\$\{if\} \$installMode == "all"\n\s+WriteRegDWORD HKLM "SOFTWARE\\\$\{FLOWN_WER_EXCLUDED\}" "\$\{FLOWN_WER_HELPER\}" 1\n\s+\$\{else\}\n\s+WriteRegDWORD HKCU "Software\\\$\{FLOWN_WER_EXCLUDED\}" "\$\{FLOWN_WER_HELPER\}" 1\n\s+\$\{endIf\}/)
    const uninstall = macro('customUnInstall')
    expect(uninstall).toMatch(/\$\{if\} \$installMode == "all"\n\s+DeleteRegValue HKLM "SOFTWARE\\\$\{FLOWN_WER_EXCLUDED\}" "\$\{FLOWN_WER_HELPER\}"\n\s+\$\{else\}\n\s+DeleteRegValue HKCU "Software\\\$\{FLOWN_WER_EXCLUDED\}" "\$\{FLOWN_WER_HELPER\}"\n\s+\$\{endIf\}/)
    // The legacy clean-up is still there.
    expect(install).toContain('Delete "$DESKTOP\\${FLOWN_LEGACY_SHORTCUT}.lnk"')
    // At run time, whatever the installer did: kernel32's calls, never wer.dll.
    const guard = read('native/ocr/src/guard.rs')
    expect(guard).toContain('WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)')
    expect(guard).toContain('SetUnhandledExceptionFilter(Some(end_quietly))')
    expect(guard).toContain('TerminateProcess(GetCurrentProcess()')
    expect(guard).toContain('SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)')
    expect(packaging.OCR_IMPORTS.map((d) => d.toLowerCase())).not.toContain('wer.dll')
    const sys = /windows-sys = \{[^}]*\}/.exec(read('native/ocr/Cargo.toml'))![0]
    expect(sys).toContain('"Win32_System_ErrorReporting"')
  })
})
