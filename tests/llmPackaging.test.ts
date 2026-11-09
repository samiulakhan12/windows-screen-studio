/**
 * Packaging the text helper of AI on this PC (docs/design/smart-tools.md §9.1, §16.7, §22 tests 78
 * and 131): ssw-llm.exe imports system DLLs only (a fixture importing WS2_32 fails) and stays
 * within LLM_BUDGET; it ships through the speech helpers' directory-form extraResources entry, so
 * it is signed with them; verify-dist fails an unsigned helper in a signed build and passes a build
 * without one, saying so; the notices name llama.cpp, and `npm run notices -- --check` fails when
 * the helper's crates are missing; the Windows build is one AVX2 build from the lock file.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const packaging = require('../scripts/lib/packaging.cjs') as {
  LLM_BUDGET: { compressed: number; installed: number }
  LLM_IMPORTS: string[]
  LLM_GGML_FLAGS: Record<string, string>
  NOTICE_NAMES: string[]
  llmHelper(): { from: string; to: string }
  llmHelperStatus(rootDir?: string): { from: string; to: string; bundle: boolean; present: boolean; reason?: string }
  llmHelperProblems(buf: Buffer, opts?: { signedBuild?: boolean }): { problems: string[]; imports: string[]; size: number; compressed: number }
  unexpectedLlmImports(names: string[]): string[]
  speechResources(rootDir?: string): { from: string; to: string; filter: string[] }[]
}

const dirs: string[] = []
const tmpDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ssw-llm-pack-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/**
 * A minimal PE32+ image whose one section holds an import directory for `dlls`, padded to `size`
 * bytes with `padding`, and signed (a certificate table at its end) when `signed`.
 */
function fakeExe(dlls: string[], opts: { machine?: number; signed?: boolean; size?: number; padding?: 'zero' | 'random' } = {}): Buffer {
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
  const body = Math.max(raw + rawSize, (opts.size ?? 0) - (opts.signed ? 64 : 0))
  const cert = opts.signed ? 64 : 0
  const buf = Buffer.alloc(body + cert)
  if (opts.padding === 'random') randomBytes(body - raw - rawSize).copy(buf, raw + rawSize)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x40, 0x3c)
  buf.write('PE\0\0', 0x40, 'latin1')
  buf.writeUInt16LE(opts.machine ?? 0x8664, 0x44)
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

/** What the real helper imports (measured on the Windows build, native/llm/README.md). */
const SYSTEM = ['KERNEL32.dll', 'ADVAPI32.dll', 'msvcrt.dll', 'ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll']

describe('verify-dist’s checks of ssw-llm.exe (test 78)', () => {
  it('passes an x64 helper importing KERNEL32, ADVAPI32 and msvcrt (and Rust’s own ntdll and synch) within its budget', () => {
    const r = packaging.llmHelperProblems(fakeExe(SYSTEM))
    expect(r.problems).toEqual([])
    expect(r.imports).toEqual(SYSTEM)
  })

  it('fails one importing WS2_32 (llama.cpp’s HTTP client linked in), or a DLL of the MinGW runtime or OpenMP', () => {
    expect(packaging.llmHelperProblems(fakeExe([...SYSTEM, 'WS2_32.dll'])).problems).toEqual([`imports WS2_32.dll; only ${packaging.LLM_IMPORTS.join(', ')} are allowed`])
    expect(packaging.unexpectedLlmImports(['kernel32.dll', 'libgomp-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll', 'bcryptprimitives.dll'])).toEqual(['libgomp-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll', 'bcryptprimitives.dll'])
  })

  it('stays within LLM_BUDGET: 9.0 MB installed and 3.0 MB compressed', () => {
    expect(packaging.LLM_BUDGET).toEqual({ compressed: 3.0e6, installed: 9.0e6 })
    const big = packaging.llmHelperProblems(fakeExe(SYSTEM, { size: 9.0e6 + 1 }))
    expect(big.problems).toEqual([`is ${9.0e6 + 1} B installed, over its budget of 9000000 B`])
    const dense = packaging.llmHelperProblems(fakeExe(SYSTEM, { size: 3.1e6, padding: 'random' }))
    expect(dense.problems.join('; ')).toMatch(/B compressed, over its budget of 3000000 B$/)
  })

  it('fails a helper that is not an x64 executable', () => {
    expect(packaging.llmHelperProblems(fakeExe(SYSTEM, { machine: 0x14c })).problems).toContain('is built for x86, not x64')
    expect(packaging.llmHelperProblems(Buffer.from('not an exe')).problems[0]).toMatch(/^is not a Windows executable/)
  })

  it('a build without the helper passes, with the section saying AI on this PC is not part of it', () => {
    const root = tmpDir()
    expect(packaging.llmHelperStatus(root)).toEqual({ from: 'native/bin/ssw-llm.exe', to: 'native/ssw-llm.exe', bundle: false, present: false })
    const verify = readFileSync(path.join(ROOT, 'scripts', 'verify-dist.mjs'), 'utf8')
    expect(verify).toContain('AI on this PC is not part of this build')
    expect(verify).toContain('llmHelperProblems(readFileSync(out), { signedBuild })')
    // The app looks for it where the entry puts it (engine.ts llmHelperPath).
    expect(readFileSync(path.join(ROOT, 'src', 'main', 'localAi', 'engine.ts'), 'utf8')).toContain("path.join(process.resourcesPath, 'native', 'ssw-llm.exe')")
    expect(packaging.llmHelper().to).toBe('native/ssw-llm.exe')
  })
})

describe('packaging ssw-llm.exe (test 131)', () => {
  it('rides the speech helpers’ directory-form extraResources entry, never a single-file from', () => {
    const root = tmpDir()
    mkdirSync(path.join(root, 'native', 'bin'), { recursive: true })
    writeFileSync(path.join(root, 'native', 'bin', 'ssw-llm.exe'), fakeExe(SYSTEM))
    expect(packaging.speechResources(root)[0]).toEqual({ from: 'native/bin', to: 'native', filter: ['ssw-llm.exe'] })
    writeFileSync(path.join(root, 'native', 'bin', 'ssw-speech.exe'), fakeExe(SYSTEM))
    expect(packaging.speechResources(root)[0]).toEqual({ from: 'native/bin', to: 'native', filter: ['ssw-speech.exe', 'ssw-llm.exe'] })
    for (const entry of packaging.speechResources(root)) expect(entry.from.endsWith('.exe')).toBe(false)
    // An x86 or cut-off file is left out, as a speech helper would be.
    writeFileSync(path.join(root, 'native', 'bin', 'ssw-llm.exe'), fakeExe(SYSTEM, { machine: 0x14c }))
    expect(packaging.speechResources(root)[0].filter).toEqual(['ssw-speech.exe'])
    expect(packaging.llmHelperStatus(root)).toMatchObject({ bundle: false, present: true, reason: 'built for x86, not x64' })
    const config = readFileSync(path.join(ROOT, 'electron-builder.config.cjs'), 'utf8')
    expect(config).toContain('...speechResources()')
    expect(config).not.toContain('ssw-llm')
  })

  it('verify-dist fails an unsigned helper in a signed build, and passes a signed one', () => {
    expect(packaging.llmHelperProblems(fakeExe(SYSTEM), { signedBuild: true }).problems).toEqual(['is not signed in a signed build'])
    expect(packaging.llmHelperProblems(fakeExe(SYSTEM, { signed: true }), { signedBuild: true }).problems).toEqual([])
    expect(packaging.llmHelperProblems(fakeExe(SYSTEM), { signedBuild: false }).problems).toEqual([])
  })

  it('the notices name llama.cpp and the helper; its crates are part of the Rust crates’ section', () => {
    expect(packaging.NOTICE_NAMES).toContain('llama.cpp')
    const notices = readFileSync(path.join(ROOT, 'scripts', 'notices.mjs'), 'utf8')
    expect(notices).toContain("'native/llm/Cargo.toml'")
    expect(notices).toMatch(/RUST_TITLE = '[^']*ssw-llm\.exe/)
    const text = readFileSync(path.join(ROOT, 'resources', 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    for (const name of ['llama.cpp', 'llama-cpp-2 0.1.161', 'llama-cpp-sys-2 0.1.161', 'enumflags2', 'thiserror', 'tracing ', 'tracing-core', 'serde_json']) expect(text, name).toContain(name)
  })

  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
  it.runIf(!cargo.error && cargo.status === 0)('`npm run notices -- --check` passes the committed file and fails without the helper’s crates', () => {
    const root = tmpDir()
    for (const p of ['scripts/notices.mjs', 'scripts/lib', 'resources/notices', 'resources/THIRD_PARTY_NOTICES.txt', 'package.json', 'native/Cargo.toml', 'native/Cargo.lock', 'native/speech/Cargo.toml', 'native/speech/Cargo.lock', 'native/llm/Cargo.toml', 'native/llm/Cargo.lock']) {
      cpSync(path.join(ROOT, p), path.join(root, p), { recursive: true })
    }
    for (const crate of ['native', 'native/speech', 'native/llm']) {
      mkdirSync(path.join(root, crate, 'src'), { recursive: true })
      writeFileSync(path.join(root, crate, 'src', 'main.rs'), 'fn main() {}\n')
    }
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction')
    const check = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [path.join(root, 'scripts', 'notices.mjs'), '--check'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
    const ok = check()
    expect(ok.status, String(ok.stderr)).toBe(0)
    const file = path.join(root, 'resources', 'THIRD_PARTY_NOTICES.txt')
    const committed = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      committed
        .split('\n')
        .filter((l) => !/^\s+llama-cpp-(sys-)?2 /.test(l))
        .join('\n')
    )
    expect(check().status).toBe(1)
  }, 180_000)
})

describe('the Windows build (§9.1)', () => {
  it('is one AVX2 build: SSE4.2, AVX, AVX2, FMA and F16C on, BMI2 and everything newer off, CPU only, no OpenMP', () => {
    const flags = packaging.LLM_GGML_FLAGS
    for (const on of ['GGML_SSE42', 'GGML_AVX', 'GGML_AVX2', 'GGML_FMA', 'GGML_F16C']) expect(flags[on], on).toBe('ON')
    for (const off of ['GGML_NATIVE', 'GGML_BMI2', 'GGML_AVX_VNNI', 'GGML_AVX512', 'GGML_AVX512_VBMI', 'GGML_AVX512_VNNI', 'GGML_AVX512_BF16', 'GGML_AMX_TILE', 'GGML_AMX_INT8', 'GGML_AMX_BF16', 'GGML_OPENMP']) expect(flags[off], off).toBe('OFF')
  })

  it('builds from the committed lock file, with the flags, and checks imports and size before copying it out', () => {
    const build = readFileSync(path.join(ROOT, 'scripts', 'build-native.mjs'), 'utf8')
    expect(build).toContain("['build', '--release', '--locked'")
    expect(build).toContain('...LLM_GGML_FLAGS')
    expect(build).toContain('unexpectedLlmImports(readImports(')
    expect(build).toContain('LLM_BUDGET.installed')
    expect(build).toContain("process.argv.includes('--llm-host')")
    expect(readFileSync(path.join(ROOT, 'native', 'llm', 'Cargo.toml'), 'utf8')).toMatch(/llama-cpp-2 = \{ version = "=0\.1\.161", default-features = false \}/)
    expect(readFileSync(path.join(ROOT, 'native', 'llm', 'Cargo.lock'), 'utf8')).toMatch(/name = "llama-cpp-sys-2"\nversion = "0\.1\.161"/)
  })
})
