// Packaging scripts (scripts/lib/*.cjs, electron-builder.config.cjs): pure logic, no Electron needed.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_USER_MODEL_ID } from '../src/shared/brand'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(__dirname, '..')

interface IcoEntry {
  width: number
  height: number
  bitCount: number
  format: 'png' | 'bmp'
  data: Buffer
}
const ico = require('../scripts/lib/ico.cjs') as {
  encodeIco(images: { size: number; png?: Uint8Array; rgba?: Uint8Array }[]): Buffer
  encodeIconDib(width: number, height: number, rgba: Uint8Array): Buffer
  parseIco(buf: Buffer): IcoEntry[]
  pngSize(png: Uint8Array): { width: number; height: number }
  encodeBmp24(width: number, height: number, rgba: Uint8Array, background?: number[]): Buffer
}
const pe = require('../scripts/lib/pe.cjs') as {
  parsePe(buf: Buffer): { machine: string; truncated: boolean; signed: boolean; rawEnd: number }
  readImports(buf: Buffer): string[]
  readResources(buf: Buffer): { type: number | null; id: number | null; lang: number | null; data: Buffer }[]
  readIconGroups(buf: Buffer): { id: number | null; images: { width: number; height: number; bitCount: number; data: Buffer | null }[] }[]
  readVersionStrings(buf: Buffer): Record<string, string>
  checkWindowsExe(file: string, options?: { minBytes?: number; pin?: { size: number; sha256: string } }): { ok: true; size: number; signed: boolean } | { ok: false; reason: string }
  peContentHash(buf: Buffer, length?: number): string
}
interface Signing {
  mode: 'unsigned' | 'pfx' | 'store' | 'azure'
  win: { signtoolOptions?: Record<string, unknown>; azureSignOptions?: Record<string, string> }
  forceCodeSigning: boolean
  errors: string[]
  warnings: string[]
  summary: string
}
const signing = require('../scripts/lib/signing.cjs') as {
  resolveWindowsSigning(env: Record<string, string | undefined>, options?: { platform?: string; projectDir?: string; exists?: (f: string) => boolean }): Signing
  loadBuilderEnv(projectDir: string, env: Record<string, string | undefined>): string[]
}
const packaging = require('../scripts/lib/packaging.cjs') as {
  appFiles(rootDir?: string): string[]
  FFMPEG_EXE: { release: string; size: number; sha256: string }
  SIGN_EXTS: string[]
  signedFiles(dir: string): string[]
  nativeHelper(): { from: string; to: string }
  nativeHelperResource(): { from: string; to: string; filter: string[] }
  nativeHelperStatus(rootDir?: string): { bundle: boolean; present: boolean; reason?: string; size?: number }
  installOnlyPackages(rootDir?: string): string[]
  runtimePackages(rootDir?: string): string[]
  foreignPrebuilds(rootDir?: string): string[]
  speechHelpers(): { from: string; to: string; build: string }[]
  speechHelperStatus(rootDir?: string): { from: string; to: string; build: string; bundle: boolean; present: boolean; reason?: string; size?: number; missingOptions?: string[] }[]
  SPEECH_HELPER_OPTIONS: string[]
  missingSpeechOptions(buf: Buffer): string[]
  staleSpeechHelper(from: string, missing: string[]): string
  speechResources(rootDir?: string): { from: string; to: string; filter: string[] }[]
  noticesResource(): { from: string; to: string; filter: string[] }
  noticesProblems(text: string): string[]
  NOTICE_NAMES: string[]
  VAD_PIN: { file: string; bytes: number; sha256: string }
  SPEECH_IMPORTS: string[]
  SPEECH_BUDGET: { compressed: number; installed: number }
  unexpectedSpeechImports(names: string[]): string[]
}
const asar = require('../scripts/lib/asar.cjs') as {
  parseAsarHeader(buf: Buffer): unknown
  listAsar(header: unknown): { path: string; size: number; unpacked: boolean; dir: boolean }[]
}

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-packaging-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

/** A fake PNG: signature + IHDR with the given size (enough for the ICO code, which stores PNGs as-is). */
function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/**
 * A minimal PE32+ image with one section that holds the given resources, laid out like the
 * linker does: type -> id -> language directories, then data entries, then the data.
 */
function fakePe(opts: {
  machine?: number
  resources?: { type: number; id: number; data: Buffer }[]
  certificate?: number
}): Buffer {
  const { machine = 0x8664, resources = [], certificate = 0 } = opts
  const sectionRva = 0x1000
  const sectionRaw = 0x200
  // Resource tree.
  const types = [...new Set(resources.map((r) => r.type))].sort((a, b) => a - b)
  const dirSize = (n: number): number => 16 + 8 * n
  let size = dirSize(types.length)
  const typeDirAt = new Map<number, number>()
  for (const t of types) {
    typeDirAt.set(t, size)
    size += dirSize(resources.filter((r) => r.type === t).length)
  }
  const langDirAt = resources.map(() => {
    const at = size
    size += dirSize(1)
    return at
  })
  const dataEntryAt = resources.map(() => {
    const at = size
    size += 16
    return at
  })
  const dataAt = resources.map((r) => {
    const at = size
    size += (r.data.length + 7) & ~7
    return at
  })
  const rsrc = Buffer.alloc(size)
  const dir = (at: number, ids: number): void => {
    rsrc.writeUInt16LE(ids, at + 14)
  }
  dir(0, types.length)
  types.forEach((t, i) => {
    rsrc.writeUInt32LE(t, 16 + i * 8)
    rsrc.writeUInt32LE(0x80000000 + typeDirAt.get(t)!, 16 + i * 8 + 4)
    const members = resources.map((r, index) => ({ r, index })).filter(({ r }) => r.type === t)
    dir(typeDirAt.get(t)!, members.length)
    members.forEach(({ r, index }, j) => {
      const e = typeDirAt.get(t)! + 16 + j * 8
      rsrc.writeUInt32LE(r.id, e)
      rsrc.writeUInt32LE(0x80000000 + langDirAt[index], e + 4)
    })
  })
  resources.forEach((r, i) => {
    dir(langDirAt[i], 1)
    rsrc.writeUInt32LE(1033, langDirAt[i] + 16)
    rsrc.writeUInt32LE(dataEntryAt[i], langDirAt[i] + 20)
    rsrc.writeUInt32LE(sectionRva + dataAt[i], dataEntryAt[i])
    rsrc.writeUInt32LE(r.data.length, dataEntryAt[i] + 4)
    r.data.copy(rsrc, dataAt[i])
  })
  const rawSize = (rsrc.length + 0x1ff) & ~0x1ff
  const certOffset = sectionRaw + rawSize
  const buf = Buffer.alloc(certOffset + certificate)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x40, 0x3c)
  buf.write('PE\0\0', 0x40, 'latin1')
  buf.writeUInt16LE(machine, 0x44)
  buf.writeUInt16LE(1, 0x46) // sections
  buf.writeUInt16LE(240, 0x54) // optional header size
  const opt = 0x58
  buf.writeUInt16LE(0x20b, opt)
  buf.writeUInt32LE(16, opt + 108) // data directories
  buf.writeUInt32LE(resources.length ? sectionRva : 0, opt + 112 + 2 * 8)
  buf.writeUInt32LE(resources.length ? rsrc.length : 0, opt + 112 + 2 * 8 + 4)
  if (certificate) {
    buf.writeUInt32LE(certOffset, opt + 112 + 4 * 8)
    buf.writeUInt32LE(certificate, opt + 112 + 4 * 8 + 4)
  }
  const sec = opt + 240
  buf.write('.rsrc', sec, 'latin1')
  buf.writeUInt32LE(rsrc.length, sec + 8)
  buf.writeUInt32LE(sectionRva, sec + 12)
  buf.writeUInt32LE(rawSize, sec + 16)
  buf.writeUInt32LE(sectionRaw, sec + 20)
  rsrc.copy(buf, sectionRaw)
  return buf
}

/**
 * A minimal PE32+ image whose one section holds an import directory (IMAGE_IMPORT_DESCRIPTORs and
 * the DLL names) and, optionally, a delay-load directory.
 */
function fakePeWithImports(dlls: string[], delayed: string[] = []): Buffer {
  const rva = 0x1000
  const raw = 0x200
  const descriptors = 20 * (dlls.length + 1)
  const delayAt = descriptors
  const delaySize = delayed.length ? 32 * (delayed.length + 1) : 0
  let namesAt = delayAt + delaySize
  const section = Buffer.alloc(namesAt + [...dlls, ...delayed].reduce((n, d) => n + d.length + 1, 0) + 16)
  dlls.forEach((d, i) => {
    section.writeUInt32LE(rva + namesAt, i * 20 + 12)
    section.writeUInt32LE(rva + 0x10, i * 20 + 16) // a FirstThunk, so the entry is not all zeros
    section.write(d, namesAt, 'latin1')
    namesAt += d.length + 1
  })
  delayed.forEach((d, i) => {
    section.writeUInt32LE(1, delayAt + i * 32)
    section.writeUInt32LE(rva + namesAt, delayAt + i * 32 + 4)
    section.write(d, namesAt, 'latin1')
    namesAt += d.length + 1
  })
  const rawSize = (section.length + 0x1ff) & ~0x1ff
  const buf = Buffer.alloc(raw + rawSize)
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
  if (delayed.length) {
    buf.writeUInt32LE(rva + delayAt, opt + 112 + 13 * 8)
    buf.writeUInt32LE(delaySize, opt + 112 + 13 * 8 + 4)
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

/** RT_GROUP_ICON data pointing at RT_ICON ids. */
function groupIcon(images: { size: number; id: number; bytes: number }[]): Buffer {
  const b = Buffer.alloc(6 + 14 * images.length)
  b.writeUInt16LE(1, 2)
  b.writeUInt16LE(images.length, 4)
  images.forEach((img, i) => {
    const e = 6 + i * 14
    b[e] = img.size === 256 ? 0 : img.size
    b[e + 1] = img.size === 256 ? 0 : img.size
    b.writeUInt16LE(1, e + 4)
    b.writeUInt16LE(32, e + 6)
    b.writeUInt32LE(img.bytes, e + 8)
    b.writeUInt16LE(img.id, e + 12)
  })
  return b
}

/** A VS_VERSIONINFO block as rc.exe writes it: header, UTF-16 key, value and children, 32-bit aligned. */
function versionBlock(key: string, value: Buffer | string | null, children: Buffer[] = []): Buffer {
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  const text = typeof value === 'string'
  const valueBytes = text ? Buffer.from(`${value}\0`, 'utf16le') : (value ?? Buffer.alloc(0))
  const head = pad(Buffer.concat([Buffer.alloc(6), Buffer.from(`${key}\0`, 'utf16le')]))
  const body = Buffer.concat([head, pad(valueBytes), ...children.map(pad)])
  body.writeUInt16LE(body.length, 0)
  body.writeUInt16LE(text ? valueBytes.length / 2 : valueBytes.length, 2)
  body.writeUInt16LE(text ? 1 : 0, 4)
  return body
}

function versionInfo(strings: Record<string, string>): Buffer {
  const table = versionBlock('040904b0', null, Object.entries(strings).map(([k, v]) => versionBlock(k, v)))
  const fixed = Buffer.alloc(52)
  fixed.writeUInt32LE(0xfeef04bd, 0)
  return versionBlock('VS_VERSION_INFO', fixed, [versionBlock('StringFileInfo', null, [table]), versionBlock('VarFileInfo', null, [versionBlock('Translation', Buffer.from([9, 4, 0xb0, 4]))])])
}

describe('ico', () => {
  it('round-trips DIB and PNG images, with 256 px stored as 0 in the directory', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255])
    const file = ico.encodeIco([
      { size: 2, rgba },
      { size: 256, png: fakePng(256, 256) }
    ])
    expect(file.readUInt8(6 + 16)).toBe(0) // 256 -> 0
    const entries = ico.parseIco(file)
    expect(entries.map((e) => [e.width, e.height, e.bitCount, e.format])).toEqual([
      [2, 2, 32, 'bmp'],
      [256, 256, 32, 'png']
    ])
    expect(ico.pngSize(entries[1].data)).toEqual({ width: 256, height: 256 })
  })

  it('writes a bottom-up BGRA DIB with an AND mask set only for fully transparent pixels', () => {
    // Top row: opaque red, half-transparent green. Bottom row: transparent blue, opaque grey.
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255])
    const dib = ico.encodeIconDib(2, 2, rgba)
    expect(dib.readInt32LE(8)).toBe(4) // doubled height
    expect(dib.readUInt16LE(14)).toBe(32)
    // First stored row is the bottom row.
    expect([...dib.subarray(40, 48)]).toEqual([255, 0, 0, 0, 30, 20, 10, 255])
    expect([...dib.subarray(48, 56)]).toEqual([0, 0, 255, 255, 0, 255, 0, 128])
    const mask = 40 + 16
    expect(dib[mask]).toBe(0x80) // bottom row: first pixel transparent
    expect(dib[mask + 4]).toBe(0) // top row: none
  })

  it('rejects malformed input', () => {
    expect(() => ico.parseIco(Buffer.from('not an icon'))).toThrow()
    const good = ico.encodeIco([{ size: 1, rgba: new Uint8Array([1, 2, 3, 4]) }])
    expect(() => ico.parseIco(good.subarray(0, good.length - 1))).toThrow(/outside/)
    expect(() => ico.encodeIco([])).toThrow()
    expect(() => ico.encodeIconDib(2, 2, new Uint8Array(3))).toThrow()
  })

  it('composites alpha over the background in 24-bit BMPs, rows padded to 4 bytes', () => {
    const bmp = ico.encodeBmp24(1, 1, new Uint8Array([200, 100, 0, 0]), [10, 20, 30])
    expect(bmp.toString('latin1', 0, 2)).toBe('BM')
    expect(bmp.length).toBe(54 + 4)
    expect([...bmp.subarray(54, 57)]).toEqual([30, 20, 10])
  })

  it('the committed build/icon.ico has every Windows size, small ones as DIBs and 256 px as PNG', () => {
    const entries = ico.parseIco(readFileSync(path.join(ROOT, 'build/icon.ico')))
    expect(entries.map((e) => e.width)).toEqual([16, 20, 24, 32, 40, 48, 64, 96, 128, 256])
    expect(entries.every((e) => e.width === e.height && e.bitCount === 32)).toBe(true)
    expect(entries.filter((e) => e.format === 'png').map((e) => e.width)).toEqual([256])
    expect(ico.pngSize(readFileSync(path.join(ROOT, 'build/icon.png')))).toEqual({ width: 512, height: 512 })
    const sidebar = readFileSync(path.join(ROOT, 'build/installerSidebar.bmp'))
    expect([sidebar.readInt32LE(18), sidebar.readInt32LE(22), sidebar.readUInt16LE(28)]).toEqual([164, 314, 24])
  })
})

describe('pe', () => {
  it('reads the version strings Explorer shows (file properties)', () => {
    const strings = { CompanyName: 'Qbexel', FileDescription: 'Flown', ProductName: 'Flown', LegalCopyright: 'Copyright © 2026 Qbexel', FileVersion: '0.1.0' }
    const exe = fakePe({ resources: [{ type: 16, id: 1, data: versionInfo(strings) }] })
    expect(pe.readVersionStrings(exe)).toEqual(strings)
    expect(pe.readVersionStrings(fakePe({}))).toEqual({})
  })

  it('reads the machine, the icon groups and the certificate of an executable', () => {
    const small = Buffer.from('small-icon')
    const big = Buffer.from('big-icon-png')
    const exe = fakePe({
      resources: [
        { type: 3, id: 1, data: small },
        { type: 3, id: 2, data: big },
        { type: 14, id: 1, data: groupIcon([
          { size: 16, id: 1, bytes: small.length },
          { size: 256, id: 2, bytes: big.length }
        ]) }
      ],
      certificate: 64
    })
    const info = pe.parsePe(exe)
    expect(info).toMatchObject({ machine: 'x64', truncated: false, signed: true })
    const groups = pe.readIconGroups(exe)
    expect(groups).toHaveLength(1)
    expect(groups[0].images.map((i) => [i.width, i.data?.toString()])).toEqual([
      [16, 'small-icon'],
      [256, 'big-icon-png']
    ])
    expect(pe.readResources(exe).map((r) => [r.type, r.id, r.lang])).toEqual([
      [3, 1, 1033],
      [3, 2, 1033],
      [14, 1, 1033]
    ])
  })

  it('checkWindowsExe rejects missing, foreign, wrong-architecture, truncated and tiny files', () => {
    const dir = tmpDir()
    const file = (name: string, data: Buffer): string => {
      writeFileSync(path.join(dir, name), data)
      return path.join(dir, name)
    }
    const good = fakePe({ resources: [{ type: 3, id: 1, data: Buffer.alloc(100) }] })
    expect(pe.checkWindowsExe(file('ok.exe', good))).toEqual({ ok: true, size: good.length, signed: false })
    expect(pe.checkWindowsExe(path.join(dir, 'none.exe'))).toEqual({ ok: false, reason: 'missing' })
    expect(pe.checkWindowsExe(file('elf', Buffer.from('\x7fELF\x02\x01\x01'.padEnd(80, '\0'))))).toMatchObject({ ok: false, reason: /no MZ/ })
    expect(pe.checkWindowsExe(file('x86.exe', fakePe({ machine: 0x14c })))).toEqual({ ok: false, reason: 'built for x86, not x64' })
    expect(pe.checkWindowsExe(file('cut.exe', good.subarray(0, good.length - 10)))).toMatchObject({ ok: false, reason: /truncated/ })
    expect(pe.checkWindowsExe(file('small.exe', good), { minBytes: good.length + 1 })).toMatchObject({ ok: false, reason: /only/ })
  })

  it('checkWindowsExe with a pin accepts only that build, before and after signing', () => {
    const dir = tmpDir()
    const file = (name: string, data: Buffer): string => {
      writeFileSync(path.join(dir, name), data)
      return path.join(dir, name)
    }
    const exe = fakePe({ resources: [{ type: 3, id: 1, data: Buffer.from('ffmpeg') }] })
    const pin = { size: exe.length, sha256: pe.peContentHash(exe) }
    expect(pe.checkWindowsExe(file('ffmpeg.exe', exe), { pin })).toEqual({ ok: true, size: exe.length, signed: false })
    // What signing does: a new checksum, the certificate table entry, padding and the table itself.
    const signedExe = Buffer.concat([exe, Buffer.alloc(64, 0xcc)])
    signedExe.writeUInt32LE(0x1234, 0x58 + 64)
    signedExe.writeUInt32LE(exe.length, 0x58 + 112 + 4 * 8)
    signedExe.writeUInt32LE(64, 0x58 + 112 + 4 * 8 + 4)
    expect(pe.checkWindowsExe(file('signed.exe', signedExe), { pin })).toEqual({ ok: true, size: signedExe.length, signed: true })
    // Any other byte, or bytes appended, is another build.
    const tampered = Buffer.from(exe)
    tampered[exe.length - 1] ^= 1
    expect(pe.checkWindowsExe(file('tampered.exe', tampered), { pin })).toMatchObject({ ok: false, reason: /SHA-256 differs/ })
    expect(pe.checkWindowsExe(file('longer.exe', Buffer.concat([exe, Buffer.alloc(512, 1)])), { pin })).toMatchObject({ ok: false, reason: /SHA-256 differs/ })
  })

  it('reads the DLLs an executable imports, delay-loaded ones included', () => {
    expect(pe.readImports(fakePeWithImports(['KERNEL32.dll', 'ntdll.dll', 'KERNEL32.dll']))).toEqual(['KERNEL32.dll', 'ntdll.dll'])
    expect(pe.readImports(fakePeWithImports(['msvcrt.dll'], ['psapi.dll']))).toEqual(['msvcrt.dll', 'psapi.dll'])
    expect(pe.readImports(fakePeWithImports([]))).toEqual([])
    expect(pe.readImports(fakePe({}))).toEqual([])
  })

  it('pins the ffmpeg.exe of the release ffmpeg-static downloads', () => {
    const ffmpegStatic = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/ffmpeg-static/package.json'), 'utf8'))
    expect(packaging.FFMPEG_EXE.release).toBe(ffmpegStatic['ffmpeg-static']['binary-release-tag'])
    expect(packaging.FFMPEG_EXE.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(packaging.FFMPEG_EXE.size).toBeGreaterThan(20 * 1024 * 1024)
  })
})

describe('signing', () => {
  const exists = (f: string): boolean => f.endsWith('cert.pfx')

  it('is unsigned without variables, and fails only when signing is required', () => {
    const r = signing.resolveWindowsSigning({}, { platform: 'linux' })
    expect(r).toMatchObject({ mode: 'unsigned', win: {}, errors: [], forceCodeSigning: false })
    const req = signing.resolveWindowsSigning({ SSW_REQUIRE_SIGNING: '1' }, { platform: 'win32' })
    expect(req.forceCodeSigning).toBe(true)
    expect(req.errors[0]).toMatch(/SSW_REQUIRE_SIGNING/)
  })

  it('uses a .pfx from CSC_LINK on any OS, SHA-256 only, and checks the file exists', () => {
    const r = signing.resolveWindowsSigning({ CSC_LINK: 'certs/cert.pfx', CSC_KEY_PASSWORD: 'x' }, { platform: 'win32', projectDir: '/p', exists })
    expect(r.mode).toBe('pfx')
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    // Linux: electron-builder's bundled osslsigncode needs OpenSSL 1.1 unless the system one is used.
    const linux = { platform: 'linux', projectDir: '/p', exists }
    expect(signing.resolveWindowsSigning({ CSC_LINK: 'cert.pfx', CSC_KEY_PASSWORD: 'x' }, linux).warnings[0]).toMatch(/USE_SYSTEM_SIGNCODE=true/)
    expect(signing.resolveWindowsSigning({ CSC_LINK: 'cert.pfx', CSC_KEY_PASSWORD: 'x', USE_SYSTEM_SIGNCODE: 'true' }, linux).warnings).toEqual([])
    expect(r.win.signtoolOptions).toEqual({ signingHashAlgorithms: ['sha256'] })
    const missing = signing.resolveWindowsSigning({ WIN_CSC_LINK: '~/other.pfx' }, { platform: 'win32', exists })
    expect(missing.errors[0]).toMatch(/WIN_CSC_LINK points to .*other\.pfx/)
    expect(missing.warnings[0]).toMatch(/CSC_KEY_PASSWORD/)
    // base64 content and https URLs are not file paths
    const b64 = signing.resolveWindowsSigning({ CSC_LINK: 'MIIK'.padEnd(3000, 'A'), CSC_KEY_PASSWORD: 'x' }, { exists })
    expect(b64.errors).toEqual([])
  })

  it('passes a timestamp server through to signtool and Azure', () => {
    const r = signing.resolveWindowsSigning(
      { CSC_LINK: 'cert.pfx', CSC_KEY_PASSWORD: 'x', WIN_SIGN_TIMESTAMP_URL: 'http://ts.example' },
      { projectDir: '/p', exists }
    )
    expect(r.win.signtoolOptions).toMatchObject({ rfc3161TimeStampServer: 'http://ts.example', timeStampServer: 'http://ts.example' })
  })

  it('configures Azure Trusted Signing on Windows when all AZURE_TRUSTED_SIGNING_* are set', () => {
    const env = {
      AZURE_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_TRUSTED_SIGNING_ACCOUNT: 'acct',
      AZURE_TRUSTED_SIGNING_PROFILE: 'prof',
      AZURE_TRUSTED_SIGNING_PUBLISHER: 'Jane Doe'
    }
    const r = signing.resolveWindowsSigning(
      { ...env, AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' },
      { platform: 'win32' }
    )
    expect(r.mode).toBe('azure')
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.win.azureSignOptions).toEqual({
      endpoint: 'https://eus.codesigning.azure.net/',
      codeSigningAccountName: 'acct',
      certificateProfileName: 'prof',
      publisherName: 'Jane Doe'
    })
    expect(signing.resolveWindowsSigning(env, { platform: 'win32' }).warnings[0]).toMatch(/Entra/)
    expect(signing.resolveWindowsSigning(env, { platform: 'linux' }).errors[0]).toMatch(/Windows build machine/)
    const partial = signing.resolveWindowsSigning({ AZURE_TRUSTED_SIGNING_ACCOUNT: 'acct' }, { platform: 'win32' })
    expect(partial.errors[0]).toMatch(/missing: AZURE_TRUSTED_SIGNING_ENDPOINT, AZURE_TRUSTED_SIGNING_PROFILE, AZURE_TRUSTED_SIGNING_PUBLISHER/)
  })

  it('refuses two signing methods at once and supports a store certificate on Windows', () => {
    const both = signing.resolveWindowsSigning({ CSC_LINK: 'cert.pfx', AZURE_TRUSTED_SIGNING_ACCOUNT: 'a' }, { platform: 'win32', exists })
    expect(both.errors[0]).toMatch(/Several code-signing methods/)
    const store = signing.resolveWindowsSigning({ WIN_SIGN_CERT_SHA1: 'ab cd ef' }, { platform: 'win32' })
    expect(store.mode).toBe('store')
    expect(store.win.signtoolOptions).toMatchObject({ certificateSha1: 'abcdef', signingHashAlgorithms: ['sha256'] })
    expect(signing.resolveWindowsSigning({ WIN_SIGN_CERT_SUBJECT: 'Jane' }, { platform: 'darwin' }).errors[0]).toMatch(/only on Windows/)
  })

  it('reads electron-builder.env like electron-builder does, without overriding the environment', () => {
    const dir = tmpDir()
    writeFileSync(path.join(dir, 'electron-builder.env'), 'CSC_LINK=from-file.pfx\nCSC_KEY_PASSWORD="p w"\n# comment\n')
    const env: Record<string, string | undefined> = { CSC_LINK: 'from-env.pfx' }
    expect(signing.loadBuilderEnv(dir, env)).toEqual(['CSC_KEY_PASSWORD'])
    expect(env).toEqual({ CSC_LINK: 'from-env.pfx', CSC_KEY_PASSWORD: 'p w' })
    expect(signing.loadBuilderEnv(tmpDir(), env)).toEqual([])
  })
})

describe('packaging', () => {
  /** root/package.json + node_modules entries: { name: dependencies }. */
  function fixture(rootDeps: Record<string, string>, packages: Record<string, Record<string, string>>): string {
    const root = tmpDir()
    writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: rootDeps })
    for (const [name, deps] of Object.entries(packages)) {
      writeJson(path.join(root, 'node_modules', name, 'package.json'), { name: name.split('/node_modules/').pop(), dependencies: deps })
    }
    return root
  }

  it('drops packages only ffmpeg-static install script uses (by name, nested too), but keeps ones a runtime dependency shares', () => {
    const root = fixture(
      { 'ffmpeg-static': '1', keep: '1' },
      {
        'ffmpeg-static': { '@scope/download': '1', shared: '1', nested: '1' },
        'ffmpeg-static/node_modules/nested': {},
        '@scope/download': { sub: '1' },
        sub: { '@types/node': '1' },
        'sub/node_modules/@types/node': {},
        keep: { shared: '1', inner: '1' },
        'keep/node_modules/inner': {},
        shared: {}
      }
    )
    // electron-builder hoists nested node_modules into app.asar's top level, so nested names count.
    expect(packaging.installOnlyPackages(root)).toEqual(['@scope/download', '@types/node', 'nested', 'sub'])
    expect(packaging.runtimePackages(root)).toEqual(['ffmpeg-static', 'inner', 'keep', 'shared'])
    const files = packaging.appFiles(root)
    expect(files).toContain('!node_modules/@scope/download{,/**}')
    expect(files).toContain('!node_modules/@types/node{,/**}')
    expect(files).toContain('!node_modules/nested{,/**}')
    expect(files).not.toContain('!node_modules/shared{,/**}')
    expect(files).not.toContain('!node_modules/inner{,/**}')
  })

  it('the files list is the single whitelist: only out/** and package.json are included', () => {
    const files = packaging.appFiles()
    expect(files.filter((f) => !f.startsWith('!'))).toEqual(['out/**', 'package.json'])
    expect(files).toContain('!out/**/*.map')
    expect(files).toContain('!node_modules/ffmpeg-static/ffmpeg')
  })

  it('lists every .exe and .node file of a packaged app folder as needing a signature', () => {
    const root = tmpDir()
    const files = ['App.exe', 'ffmpeg.dll', 'resources/elevate.exe', 'resources/app.asar', 'resources/native/ssw-capture.exe',
      'resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe', 'resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node']
    for (const f of files) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
      writeFileSync(path.join(root, f), '')
    }
    expect(packaging.signedFiles(root)).toEqual([
      'App.exe',
      'resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe',
      'resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node',
      'resources/elevate.exe',
      'resources/native/ssw-capture.exe'
    ])
  })

  it('lists every uiohook-napi prebuild except win32-x64', () => {
    const root = tmpDir()
    for (const d of ['win32-x64', 'win32-arm64', 'linux-x64']) mkdirSync(path.join(root, 'node_modules/uiohook-napi/prebuilds', d), { recursive: true })
    expect(packaging.foreignPrebuilds(root).sort()).toEqual(['linux-x64', 'win32-arm64'])
    expect(packaging.foreignPrebuilds(tmpDir())).toEqual([])
  })

  it('maps the native helper where src/main/nativeCapture.ts looks for it (resources/native/ssw-capture.exe)', () => {
    expect(packaging.nativeHelper()).toEqual({ from: 'native/bin/ssw-capture.exe', to: 'native/ssw-capture.exe' })
    // A directory entry, so electron-builder signs the exe while copying it.
    expect(packaging.nativeHelperResource()).toEqual({ from: 'native/bin', to: 'native', filter: ['ssw-capture.exe'] })
  })

  it('bundles the native helper only when it is a complete x64 executable, and never fails without it', () => {
    const root = tmpDir()
    expect(packaging.nativeHelperStatus(root)).toEqual({ bundle: false, present: false })
    const file = path.join(root, 'native/bin/ssw-capture.exe')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'MZ but not really')
    expect(packaging.nativeHelperStatus(root)).toMatchObject({ bundle: false, present: true, reason: /not a Windows executable/ })
    const exe = fakePe({})
    writeFileSync(file, exe)
    expect(packaging.nativeHelperStatus(root)).toEqual({ bundle: true, present: true, size: exe.length })
  })
})

describe('speech packaging (docs/design/offline-captions.md §6)', () => {
  it('maps both speech helpers where the main process looks for them', () => {
    expect(packaging.speechHelpers()).toEqual([
      { from: 'native/bin/ssw-speech.exe', to: 'native/ssw-speech.exe', build: 'standard' },
      { from: 'native/bin/ssw-speech-compat.exe', to: 'native/ssw-speech-compat.exe', build: 'compatible' }
    ])
  })

  it('bundles each speech helper only when it is a complete x64 executable, in directory form', () => {
    const root = tmpDir()
    expect(packaging.speechHelperStatus(root).map((h) => [h.bundle, h.present])).toEqual([
      [false, false],
      [false, false]
    ])
    // Without helpers the model and its MODEL.md still ship (the detector's fallback is the app's).
    expect(packaging.speechResources(root)).toEqual([{ from: 'resources/speech', to: 'speech', filter: ['ggml-silero-v6.2.0.bin', 'MODEL.md'] }])
    mkdirSync(path.join(root, 'native/bin'), { recursive: true })
    writeFileSync(path.join(root, 'native/bin/ssw-speech.exe'), fakePe({}))
    writeFileSync(path.join(root, 'native/bin/ssw-speech-compat.exe'), fakePe({ machine: 0x14c }))
    const [standard, compat] = packaging.speechHelperStatus(root)
    expect(standard).toMatchObject({ bundle: true, present: true, build: 'standard' })
    expect(compat).toMatchObject({ bundle: false, present: true, reason: 'built for x86, not x64' })
    expect(packaging.speechResources(root)[0]).toEqual({ from: 'native/bin', to: 'native', filter: ['ssw-speech.exe'] })
    writeFileSync(path.join(root, 'native/bin/ssw-speech-compat.exe'), fakePe({}))
    expect(packaging.speechResources(root)).toEqual([
      { from: 'native/bin', to: 'native', filter: ['ssw-speech.exe', 'ssw-speech-compat.exe'] },
      { from: 'resources/speech', to: 'speech', filter: ['ggml-silero-v6.2.0.bin', 'MODEL.md'] }
    ])
    expect(packaging.noticesResource()).toEqual({ from: 'resources', to: '.', filter: ['THIRD_PARTY_NOTICES.txt'] })
    // Every .exe is signed already: nothing new for signExts.
    expect(packaging.SIGN_EXTS).toEqual(['.node'])
  })

  it('refuses a speech helper built from older sources: it must know every option the catalog’s models pass (offline-captions §14.3)', async () => {
    const { SPEECH_MODELS } = await import('../src/shared/speech/catalog')
    const { modelArgs } = await import('../src/shared/speech/protocol')
    // Every option a model passes, so a new one cannot be added without the check.
    expect([...packaging.SPEECH_HELPER_OPTIONS].sort()).toEqual([...new Set(SPEECH_MODELS.flatMap((m) => modelArgs(m)).filter((a) => a.startsWith('--')))].sort())
    const current = Buffer.concat([fakePe({}), Buffer.from('--model-dir--model--audio--max-chunk--no-timestamps--verbose', 'latin1')])
    // Flown 0.4.0's helper parsed --max-chunk (a debug option then) but not --no-timestamps.
    const old = Buffer.concat([fakePe({}), Buffer.from('--model-dir--model--audio--max-chunk--verbose', 'latin1')])
    expect(packaging.missingSpeechOptions(current)).toEqual([])
    expect(packaging.missingSpeechOptions(old)).toEqual(['--no-timestamps'])
    const root = tmpDir()
    mkdirSync(path.join(root, 'native/bin'), { recursive: true })
    writeFileSync(path.join(root, 'native/bin/ssw-speech.exe'), current)
    writeFileSync(path.join(root, 'native/bin/ssw-speech-compat.exe'), old)
    expect(packaging.speechHelperStatus(root).map((h) => [h.bundle, h.missingOptions])).toEqual([
      [true, []],
      [true, ['--no-timestamps']]
    ])
    expect(packaging.staleSpeechHelper('native/bin/ssw-speech-compat.exe', ['--no-timestamps'])).toBe(
      'native/bin/ssw-speech-compat.exe was built from older sources: it does not know --no-timestamps, which this version of Flown passes (the Bangla model), so every Bangla caption run would fail. Rebuild it (npm run build:native) or copy in the helpers built from this commit.'
    )
    // predist and verify-dist refuse it.
    for (const script of ['predist.mjs', 'verify-dist.mjs']) expect(readFileSync(path.join(ROOT, 'scripts', script), 'utf8')).toContain('staleSpeechHelper(')
  })

  it('allows only system DLLs in the speech helpers (bcryptprimitives for Rust, never psapi)', () => {
    expect(packaging.SPEECH_IMPORTS).toEqual(['KERNEL32.dll', 'ADVAPI32.dll', 'msvcrt.dll', 'ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'bcryptprimitives.dll'])
    expect(packaging.unexpectedSpeechImports(['kernel32.dll', 'ADVAPI32.dll', 'bcryptprimitives.dll'])).toEqual([])
    expect(packaging.unexpectedSpeechImports(['KERNEL32.dll', 'PSAPI.DLL', 'libstdc++-6.dll', 'libwinpthread-1.dll'])).toEqual(['PSAPI.DLL', 'libstdc++-6.dll', 'libwinpthread-1.dll'])
    expect(packaging.SPEECH_BUDGET).toEqual({ compressed: 3.5e6, installed: 10e6 })
  })

  it('pins the shipped speech detector model like the catalog, and the test model like the catalog', async () => {
    const { VAD_MODEL, speechModel, modelUrl } = await import('../src/shared/speech/catalog')
    expect(packaging.VAD_PIN).toEqual({ file: VAD_MODEL.file, bytes: VAD_MODEL.bytes, sha256: VAD_MODEL.sha256 })
    const script = pathToFileURL(path.join(ROOT, 'scripts', 'fetch-test-speech.mjs')).href
    const { TEST_MODEL } = (await import(script)) as { TEST_MODEL: Record<string, unknown> }
    const tiny = speechModel('whisper-tiny')!
    expect(TEST_MODEL).toEqual({ id: tiny.id, file: tiny.file, bytes: tiny.bytes, sha256: tiny.sha256, url: modelUrl(tiny) })
  })

  it('commits third-party notices that name what ships, and checks them', () => {
    const text = readFileSync(path.join(ROOT, 'resources', 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    expect(packaging.noticesProblems(text)).toEqual([])
    expect(packaging.NOTICE_NAMES).toEqual(['whisper.cpp', 'ggml', 'Silero VAD', 'OpenAI Whisper', 'Bengali.AI', 'mingw-w64', 'FFmpeg', 'Electron', 'React', 'MediaPipe'])
    expect(packaging.noticesProblems('React and Electron')).toEqual(['only 18 bytes (at least 10 KB expected)', 'does not name whisper.cpp, ggml, Silero VAD, OpenAI Whisper, Bengali.AI, mingw-w64, FFmpeg, MediaPipe'])
    // The hand-written entries are part of it.
    for (const f of readdirSync(path.join(ROOT, 'resources', 'notices'))) {
      expect(text).toContain(readFileSync(path.join(ROOT, 'resources', 'notices', f), 'utf8').trim().split('\n')[0])
    }
    // The Rust standard library, statically linked into every helper, is not a cargo dependency.
    expect(text).toContain('Rust standard library (std, core, alloc and the crates it is built with)')
    expect(text).toContain('Copyright (c) The Rust Project Developers')
  })

  it('credits the Bangla model as the catalog pins it, under the Apache License whose text the notices hold (offline-captions §14)', async () => {
    const { BANGLA_MODEL, speechModel } = await import('../src/shared/speech/catalog')
    const bn = speechModel(BANGLA_MODEL)!
    const text = readFileSync(path.join(ROOT, 'resources', 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    const entry = readFileSync(path.join(ROOT, 'resources', 'notices', '14-bengaliai-whisper.txt'), 'utf8')
    expect(text).toContain(entry.trim())
    // Line breaks in the entry do not split what is checked.
    const flat = entry.replace(/\s+/g, ' ')
    for (const part of [
      bn.license.url,
      `https://huggingface.co/${bn.repo!.repo}`,
      bn.repo!.commit,
      bn.file,
      bn.sha256,
      '539,257,671 bytes',
      'Apache License, Version 2.0',
      'fine-tuned from OpenAI Whisper medium',
      'nothing was retrained',
      'It is not part of the installer.'
    ])
      expect(flat).toContain(part)
    expect(bn.license.name).toBe('Apache-2.0')
    // The full licence text it points to is in the file.
    expect(text).toMatch(/Apache License\s+Version 2\.0, January 2004/)
    expect(text).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
  })

  /** process.env without PATH (any case) or SSW_REQUIRE_NATIVE, and PATH holding node alone: no cargo. */
  const withoutCargo = (env: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH' && k !== 'SSW_REQUIRE_NATIVE')),
    PATH: path.dirname(process.execPath),
    ...env
  })

  it('checks and writes the notices without cargo, keeping the committed Rust crates, except for release builds', async () => {
    // A copy of what scripts/notices.mjs reads, so the committed file is never touched.
    const root = tmpDir()
    for (const p of ['scripts/notices.mjs', 'scripts/lib', 'resources/notices', 'resources/THIRD_PARTY_NOTICES.txt', 'package.json']) {
      cpSync(path.join(ROOT, p), path.join(root, p), { recursive: true })
    }
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction')
    const notices = (args: string[], env = withoutCargo()) => spawnSync(process.execPath, [path.join(root, 'scripts', 'notices.mjs'), ...args], { cwd: root, env, encoding: 'utf8' })
    const check = notices(['--check'])
    expect(check.status, check.stderr).toBe(0)
    expect(check.stderr).toContain("cargo was not found, so the Rust crates' section is kept from resources/THIRD_PARTY_NOTICES.txt unchecked")
    expect(notices(['--check'], withoutCargo({ SSW_REQUIRE_NATIVE: '1' })).status).toBe(1)
    // The rest is still generated: a new hand-written entry makes the file stale, and writing it
    // keeps the Rust crates' section as committed.
    const file = path.join(root, 'resources', 'THIRD_PARTY_NOTICES.txt')
    const before = readFileSync(file, 'utf8')
    writeFileSync(path.join(root, 'resources', 'notices', '99-test.txt'), 'A component added without cargo\n')
    expect(notices(['--check']).status).toBe(1)
    const write = notices([])
    expect(write.status, write.stderr).toBe(0)
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('A component added without cargo')
    const { rustSection } = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'notices.mjs')).href)) as { rustSection(text: string): string | null }
    expect(rustSection(before)).toMatch(/^={78}\nRust crates compiled into the native helpers/)
    expect(rustSection(after)).toBe(rustSection(before))
  })

  it('reuses usable prebuilt speech helpers on a Windows build host, and fails a required build only without them', () => {
    // build-native.mjs as on Windows (process.platform faked), from a copy of the scripts whose
    // native/bin holds both helpers; without cargo the capture helper is skipped.
    const root = tmpDir()
    cpSync(path.join(ROOT, 'scripts', 'build-native.mjs'), path.join(root, 'scripts', 'build-native.mjs'))
    cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(root, 'scripts', 'lib'), { recursive: true })
    const preload = path.join(root, 'win32.cjs')
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' })\n")
    mkdirSync(path.join(root, 'native', 'bin'), { recursive: true })
    const current = Buffer.concat([fakePe({}), Buffer.from(packaging.SPEECH_HELPER_OPTIONS.join(''), 'latin1')])
    for (const h of packaging.speechHelpers()) writeFileSync(path.join(root, h.from), fakePe({}))
    const build = (env?: Record<string, string>) =>
      spawnSync(process.execPath, ['-r', preload, path.join(root, 'scripts', 'build-native.mjs')], { cwd: root, env: withoutCargo(env), encoding: 'utf8' })
    // Helpers from older sources (without --no-timestamps) are not reused: a required build fails.
    const stale = build({ SSW_REQUIRE_NATIVE: '1' })
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('native/bin/ssw-speech.exe is from older sources (it does not know --max-chunk, --no-timestamps)')
    for (const h of packaging.speechHelpers()) writeFileSync(path.join(root, h.from), current)
    const plain = build()
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stderr).toContain('reusing the prebuilt native/bin/ssw-speech.exe and native/bin/ssw-speech-compat.exe (not rebuilt now)')
    expect(plain.stderr).not.toContain('captions on this PC will be unavailable')
    // Required: only the capture helper fails here.
    const required = build({ SSW_REQUIRE_NATIVE: '1' })
    expect(required.stderr).toContain('ssw-capture.exe: no Rust toolchain found')
    expect(required.stderr).toContain('1 helper(s) could not be built')
    rmSync(path.join(root, 'native', 'bin', 'ssw-speech-compat.exe'))
    const missing = build({ SSW_REQUIRE_NATIVE: '1' })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('native/bin/ssw-speech-compat.exe is missing')
    expect(missing.stderr).toContain('2 helper(s) could not be built')
  })
})

describe('electron-builder.config.cjs', () => {
  function loadConfig(): Record<string, any> {
    const file = require.resolve('../electron-builder.config.cjs')
    delete require.cache[file]
    const saved: Record<string, string | undefined> = {}
    const log = console.log
    const warn = console.warn
    try {
      for (const k of Object.keys(process.env)) {
        if (!/^(CSC_|WIN_CSC_|WIN_SIGN_|AZURE_|SSW_REQUIRE)/.test(k)) continue
        saved[k] = process.env[k]
        delete process.env[k]
      }
      console.log = console.warn = () => {}
      return require(file)
    } finally {
      console.log = log
      console.warn = warn
      Object.assign(process.env, saved)
    }
  }

  it('names the app Flown by Qbexel and keeps upgrading installs of Screen Studio for Windows', () => {
    const config = loadConfig()
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect([pkg.name, pkg.productName, pkg.author, pkg.homepage]).toEqual(['flown', 'Flown', { name: 'Qbexel', url: 'https://qbexel.com' }, 'https://qbexel.com'])
    expect([config.productName, config.executableName, config.copyright]).toEqual(['Flown', 'Flown', 'Copyright © 2026 Qbexel'])
    expect(config.win.artifactName).toBe('Flown-Setup-${version}.${ext}')
    expect([config.nsis.shortcutName, config.nsis.uninstallDisplayName]).toEqual(['Flown', 'Flown'])
    // The shortcuts' AppUserModelID is the appId; the app sets the same one (taskbar grouping).
    expect(config.appId).toBe(APP_USER_MODEL_ID)
    // The product GUID electron-builder derived from the old appId: the installer finds and
    // uninstalls the old app instead of installing Flown beside it.
    const { UUID } = require('builder-util-runtime') as { UUID: { parse(s: string): Buffer; v5(name: string, ns: Buffer): string } }
    const namespace = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')
    expect(config.nsis.guid).toBe(UUID.v5('com.samiulakhan12.screenstudio', namespace))
    expect(config.nsis.guid).not.toBe(UUID.v5(config.appId, namespace))
    const nsh = readFileSync(path.join(ROOT, config.nsis.include), 'utf8')
    expect(nsh).toMatch(/!macro customInit/)
    expect(nsh).toContain('!define FLOWN_LEGACY_DIR "\\Screen Studio for Windows"')
    expect(nsh).toContain('!define FLOWN_LEGACY_SHORTCUT "Screen Studio for Windows"')
  })

  it('ships one files whitelist, English only, our icons, and the native helper when it is built', () => {
    const config = loadConfig()
    expect(config.files).toEqual(packaging.appFiles())
    expect(config.win.files).toBeUndefined()
    expect(config.electronLanguages).toEqual(['en-US'])
    expect(config.compression).toBe('maximum')
    // Updates come from this repository's GitHub releases (docs/design/auto-update.md §1.1).
    expect(config.publish).toEqual([{ provider: 'github', owner: 'samiulakhan12', repo: 'windows-screen-studio', releaseType: 'release' }])
    expect(config.win.signtoolOptions).toBeUndefined()
    expect(config.win.azureSignOptions).toBeUndefined()
    for (const f of [config.win.icon, config.nsis.installerIcon, config.nsis.uninstallerIcon, config.nsis.installerSidebar]) {
      expect(existsSync(path.join(ROOT, f))).toBe(true)
    }
    expect(config.extraResources).toEqual([
      ...(packaging.nativeHelperStatus().bundle ? [packaging.nativeHelperResource()] : []),
      ...packaging.speechResources(),
      packaging.noticesResource()
    ])
    // Nothing of the speech feature goes into app.asar or asarUnpack.
    expect(config.asarUnpack).toEqual(['node_modules/ffmpeg-static/ffmpeg.exe*', 'node_modules/uiohook-napi/**'])
  })

  it('signs the uiohook-napi .node besides every .exe', () => {
    expect(loadConfig().win.signExts).toEqual(['.node'])
  })

  it('turns off running as Node, NODE_OPTIONS and --inspect, and checks app.asar integrity', () => {
    expect(loadConfig().electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    })
  })
})

describe('asar', () => {
  it('lists files and directories from the archive header', () => {
    const json = JSON.stringify({
      files: {
        'package.json': { size: 10, offset: '0' },
        out: { files: { main: { files: { 'index.js': { size: 5, offset: '10' } } } } },
        node_modules: { files: { 'ffmpeg-static': { files: { 'ffmpeg.exe': { size: 99, unpacked: true } } } } }
      }
    })
    const header = Buffer.alloc(16 + json.length)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(8 + json.length, 4)
    header.writeUInt32LE(4 + json.length, 8)
    header.writeUInt32LE(json.length, 12)
    header.write(json, 16)
    const list = asar.listAsar(asar.parseAsarHeader(header))
    expect(list.map((e) => e.path)).toEqual([
      '/package.json',
      '/out',
      '/out/main',
      '/out/main/index.js',
      '/node_modules',
      '/node_modules/ffmpeg-static',
      '/node_modules/ffmpeg-static/ffmpeg.exe'
    ])
    expect(list.find((e) => e.path.endsWith('ffmpeg.exe'))).toMatchObject({ size: 99, unpacked: true, dir: false })
    expect(() => asar.parseAsarHeader(Buffer.from('nope, not an archive'))).toThrow()
  })
})
