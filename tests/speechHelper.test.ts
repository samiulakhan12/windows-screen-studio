/**
 * The speech helper as a child process (src/main/speech/helper.ts) against the fake helper
 * (tests/fixtures/fake-speech-helper.cjs, through SSW_SPEECH_HELPER) and shell-script "builds"
 * for the packaged choice: line caps, what an exit means, the build choice, the cancel
 * sequence, the stall watchdog and the time limit, the minimal environment and working folders.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidecarCpu, SidecarEvent } from '../src/shared/speech/protocol'

const h = vi.hoisted(() => ({ packaged: false, root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-speech-helper-')) as string }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getAppPath: () => require('node:path').resolve(__dirname, '..'),
    getPath: (name: string) => require('node:path').join(h.root, name),
    on: () => undefined
  }
}))

import { ProjectProcesses } from '../src/main/projectProcesses'
import {
  chooseBuild,
  classifyExit,
  LineSplitter,
  markIllegalInstruction,
  minimalEnv,
  resetHelperSelection,
  resetSpeechWatchdogs,
  runHelper,
  selectHelper,
  speechHelperPaths,
  SPEECH_TIMING,
  type SpeechRun
} from '../src/main/speech/helper'
import { partLimitMs } from '../src/main/speech/localClient'
import { speechModel } from '../src/shared/speech/catalog'

const FAKE = path.resolve(__dirname, 'fixtures/fake-speech-helper.cjs')
const log = path.join(h.root, 'calls.jsonl')
const calls = (): { args: string[]; cwd: string; env: string[] }[] =>
  readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

const ENV_KEYS = ['SSW_SPEECH_HELPER', 'FAKE_SPEECH_MODE', 'FAKE_SPEECH_LOG', 'FAKE_SPEECH_CPU', 'FAKE_SPEECH_MATCH', 'FAKE_SPEECH_TIMES', 'FAKE_SPEECH_COUNTER']
beforeEach(() => {
  h.packaged = false
  resetHelperSelection()
  process.env.SSW_SPEECH_HELPER = FAKE
  process.env.FAKE_SPEECH_LOG = log
  writeFileSync(log, '')
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  vi.useRealTimers()
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

async function drain(run: SpeechRun): Promise<SidecarEvent[]> {
  const out: SidecarEvent[] = []
  for await (const e of run.events) out.push(e)
  return out
}

const cpu = (over: Partial<SidecarCpu> = {}): SidecarCpu => ({ type: 'cpu', sse42: true, avx: true, avx2: true, fma: true, f16c: true, bmi2: true, logical: 4, ...over })

describe('LineSplitter', () => {
  it('splits lines across chunk boundaries, handles CRLF and a last line without newline', () => {
    const lines: string[] = []
    const s = new LineSplitter((l) => lines.push(l), 100, 1000)
    expect(s.push(Buffer.from('{"a":'))).toBeNull()
    expect(s.push(Buffer.from('1}\r\n{"b"'))).toBeNull()
    expect(s.push(Buffer.from(':2}\n\n{"c":3}'))).toBeNull()
    s.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('splits a UTF-8 character cut between chunks correctly', () => {
    const lines: string[] = []
    const s = new LineSplitter((l) => lines.push(l))
    const bytes = Buffer.from('é\n')
    s.push(bytes.subarray(0, 1))
    s.push(bytes.subarray(1))
    expect(lines).toEqual(['é'])
  })

  it('reports a line over the line cap, also across chunks, and output over the total cap', () => {
    const s = new LineSplitter(() => undefined, 10, 1000)
    expect(s.push(Buffer.from('12345'))).toBeNull()
    expect(s.push(Buffer.from('678901'))).toMatch(/longer than 10/)
    const t = new LineSplitter(() => undefined, 100, 20)
    expect(t.push(Buffer.from('short\nshort\n'))).toBeNull()
    expect(t.push(Buffer.from('more than twenty\n'))).toMatch(/more than 20/)
  })
})

describe('classifyExit', () => {
  it('reads Windows codes, Linux signals and the protocol exits', () => {
    expect(classifyExit(0, null, null, null)).toEqual({ kind: 'ok' })
    expect(classifyExit(2, null, null, { doneUntil: 3 })).toEqual({ kind: 'cancelled', doneUntil: 3 })
    expect(classifyExit(1, null, { code: 'memory', message: 'm' }, null)).toEqual({ kind: 'error', code: 'memory', message: 'm' })
    expect(classifyExit(3221225501, null, null, null)).toMatchObject({ kind: 'crash', illegalInstruction: true })
    expect(classifyExit(-1073741795, null, null, null)).toMatchObject({ kind: 'crash', illegalInstruction: true })
    expect(classifyExit(null, 'SIGILL', null, null)).toMatchObject({ kind: 'crash', illegalInstruction: true })
    for (const code of [3221225477, 3221226505, 3221225725]) expect(classifyExit(code, null, null, null)).toMatchObject({ kind: 'crash', illegalInstruction: false })
    for (const sig of ['SIGSEGV', 'SIGABRT', 'SIGKILL'] as const) expect(classifyExit(null, sig, null, null)).toMatchObject({ kind: 'crash', illegalInstruction: false })
    // An error code without its line, or exit 2 without a cancelled line, is a crash.
    expect(classifyExit(1, null, null, null).kind).toBe('crash')
    expect(classifyExit(2, null, null, null).kind).toBe('crash')
  })
})

describe('chooseBuild', () => {
  it('needs every extension of the standard build, BMI2 included', () => {
    expect(chooseBuild(cpu())).toBe('standard')
    expect(chooseBuild(cpu({ bmi2: false }))).toBe('compatible')
    expect(chooseBuild(cpu({ avx2: false }))).toBe('compatible')
    expect(chooseBuild(cpu({ sse42: false }))).toBe('compatible')
    expect(chooseBuild(null)).toBe('compatible')
  })
})

describe('minimalEnv', () => {
  it('keeps only what the C runtime needs', () => {
    const from = { PATH: '/bin', LANG: 'C', OPENAI_API_KEY: 'sk-secret', HTTPS_PROXY: 'x', SystemRoot: 'C:\\Windows', TEMP: 't', TMP: 't2', HOME: '/root' }
    expect(minimalEnv('linux', from)).toEqual({ PATH: '/bin', LANG: 'C' })
    expect(minimalEnv('win32', from)).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 't', TMP: 't2', PATH: '/bin' })
  })
})

describe('partLimitMs', () => {
  it('is max(10 min, 4 × the estimate), with the compatible factor and a measured speed', () => {
    const turbo = speechModel('whisper-turbo')!
    const base = speechModel('whisper-base')!
    expect(partLimitMs(base, 600, 3, null, 'standard')).toBe(SPEECH_TIMING.partMinMs)
    // turbo, 180 s, 2 threads: 180 × 1.138 × 1.78 × 1.3 × 4 s.
    expect(partLimitMs(turbo, 180, 2, null, 'standard')).toBeCloseTo(180 * 1.138 * 1.78 * 1.3 * 4 * 1000, 0)
    expect(partLimitMs(base, 600, 1, null, 'compatible')).toBeCloseTo(600 * 0.079 * 3.21 * 1.3 * 4.3 * 4 * 1000, 0)
    expect(partLimitMs(base, 600, 4, { rtf: 1, threads: 4 }, 'compatible')).toBe(600 * 4 * 1000)
  })
})

describe('runHelper with the fake helper', () => {
  it('spawns without a shell, with the minimal environment, in the folder given', async () => {
    const run = runHelper(FAKE, ['cpu'], { cwd: os.tmpdir(), stdin: 'none', signal: new AbortController().signal })
    expect(await drain(run)).toEqual([cpu()])
    expect(await run.done).toEqual({ kind: 'ok' })
    const [c] = calls()
    expect(c.cwd).toBe(os.tmpdir())
    // A script override gets ELECTRON_RUN_AS_NODE and FAKE_SPEECH_* only; never keys or proxies.
    expect(c.env.filter((k) => !k.startsWith('FAKE_SPEECH_') && !['PATH', 'LANG', 'ELECTRON_RUN_AS_NODE'].includes(k))).toEqual([])
  })

  it('drops invalid lines and ends the run as protocol on a line over 1 MB', async () => {
    process.env.FAKE_SPEECH_MODE = 'garbage'
    const garbage = runHelper(FAKE, ['cpu'], { cwd: os.tmpdir(), stdin: 'none', signal: new AbortController().signal })
    expect(await drain(garbage)).toEqual([])
    expect(await garbage.done).toEqual({ kind: 'ok' })
    process.env.FAKE_SPEECH_MODE = 'overflow'
    const big = runHelper(FAKE, ['cpu'], { cwd: os.tmpdir(), stdin: 'none', signal: new AbortController().signal })
    await drain(big)
    expect(await big.done).toMatchObject({ kind: 'protocol' })
  })

  it('maps error lines and crashes', async () => {
    process.env.FAKE_SPEECH_MODE = 'memory'
    expect(await runHelper(FAKE, ['cpu'], { cwd: os.tmpdir(), stdin: 'none', signal: new AbortController().signal }).done).toEqual({ kind: 'error', code: 'memory', message: 'fake memory error' })
    process.env.FAKE_SPEECH_MODE = 'crash'
    expect(await runHelper(FAKE, ['cpu'], { cwd: os.tmpdir(), stdin: 'none', signal: new AbortController().signal }).done).toMatchObject({ kind: 'crash', illegalInstruction: false })
    process.env.FAKE_SPEECH_MODE = 'illegal'
    expect(await runHelper(FAKE, ['cpu'], { cwd: os.tmpdir(), stdin: 'none', signal: new AbortController().signal }).done).toMatchObject({ kind: 'crash', illegalInstruction: true })
  })

  it('cancels with "cancel", the end of stdin, then a kill after 2 s; an aborted run is cancelled whatever its exit', async () => {
    const wav = path.join(h.root, 'a.wav')
    writeFileSync(wav, Buffer.alloc(44 + 32000 * 3))
    process.env.FAKE_SPEECH_MODE = 'hang'
    const quick = new AbortController()
    const run = runHelper(FAKE, ['transcribe', '--audio', wav, '--lang', 'auto'], { cwd: h.root, stdin: 'control', signal: quick.signal })
    setTimeout(() => quick.abort(), 100)
    const events = await drain(run)
    expect(await run.done).toEqual({ kind: 'cancelled', doneUntil: 0 })
    expect(events.some((e) => e.type === 'cancelled')).toBe(true)

    // A helper that ignores the cancel line is killed after the grace period; still 'cancelled', never a crash.
    process.env.FAKE_SPEECH_MODE = 'slow-cancel'
    const slow = new AbortController()
    const t0 = Date.now()
    const stubborn = runHelper(FAKE, ['transcribe', '--audio', wav], { cwd: h.root, stdin: 'control', signal: slow.signal })
    setTimeout(() => slow.abort(), 100)
    await drain(stubborn)
    expect(await stubborn.done).toEqual({ kind: 'cancelled', doneUntil: 0 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SPEECH_TIMING.cancelGraceMs)
  })

  it('a run stopped through ProjectProcesses (the editor closed) is cancelled, not a crash', async () => {
    const wav = path.join(h.root, 'b.wav')
    writeFileSync(wav, Buffer.alloc(44 + 32000))
    process.env.FAKE_SPEECH_MODE = 'hang'
    const processes = new ProjectProcesses()
    const run = runHelper(FAKE, ['transcribe', '--audio', wav], { cwd: h.root, stdin: 'control', signal: new AbortController().signal, processes, owner: 'p1' })
    setTimeout(() => void processes.stop('p1'), 150)
    await drain(run)
    expect(await run.done).toMatchObject({ kind: 'cancelled' })
  })

  it('kills a helper that prints nothing for stallMs as stalled; every line resets the watchdog', async () => {
    const wav = path.join(h.root, 'c.wav')
    writeFileSync(wav, Buffer.alloc(44 + 32000))
    process.env.FAKE_SPEECH_MODE = 'stall'
    const stuck = runHelper(FAKE, ['transcribe', '--audio', wav], { cwd: h.root, stdin: 'control', signal: new AbortController().signal, stallMs: 400 })
    await drain(stuck)
    expect(await stuck.done).toEqual({ kind: 'stalled' })
    // Heartbeats every 50 ms keep it alive past the stall time; the overall limit still ends it.
    process.env.FAKE_SPEECH_MODE = 'hang'
    const t0 = Date.now()
    const alive = runHelper(FAKE, ['transcribe', '--audio', wav], { cwd: h.root, stdin: 'control', signal: new AbortController().signal, stallMs: 300, timeoutMs: 1200 })
    await drain(alive)
    expect(await alive.done).toEqual({ kind: 'stalled' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1100)
  })

  it('resetting the watchdogs (the PC resumed) restarts the stall timer', async () => {
    const wav = path.join(h.root, 'd.wav')
    writeFileSync(wav, Buffer.alloc(44 + 32000))
    process.env.FAKE_SPEECH_MODE = 'stall'
    const controller = new AbortController()
    const run = runHelper(FAKE, ['transcribe', '--audio', wav], { cwd: h.root, stdin: 'control', signal: controller.signal, stallMs: 500 })
    const timer = setInterval(resetSpeechWatchdogs, 100)
    let settled = false
    void run.done.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 1200))
    expect(settled).toBe(false)
    clearInterval(timer)
    await drain(run)
    expect(await run.done).toEqual({ kind: 'stalled' })
    controller.abort()
  })
})

describe('selectHelper', () => {
  it('development: the override is the host build, checked with its probe', async () => {
    expect(await selectHelper()).toEqual({ exe: FAKE, build: 'host' })
    expect(calls()[0].args).toEqual(['cpu', '--parent-pid', String(process.pid)])
    expect(calls()[0].cwd).toBe(os.tmpdir())
    // Once per session.
    await selectHelper()
    expect(calls()).toHaveLength(1)
  })

  it('a missing helper, or a probe that fails, makes the engine unavailable with a reason', async () => {
    process.env.SSW_SPEECH_HELPER = '/nonexistent/ssw-speech'
    expect(await selectHelper()).toMatchObject({ error: 'missing' })
    resetHelperSelection()
    process.env.SSW_SPEECH_HELPER = FAKE
    process.env.FAKE_SPEECH_MODE = 'crash'
    expect(await selectHelper()).toMatchObject({ error: 'failed' })
    resetHelperSelection()
    process.env.FAKE_SPEECH_MODE = 'illegal'
    expect(await selectHelper()).toMatchObject({ error: 'cpu' })
  })

  describe('packaged', () => {
    const resources = mkdtempSync(path.join(os.tmpdir(), 'ssw-speech-res-'))
    const writeExe = (name: string, cpuJson: string): void => {
      const file = path.join(resources, 'native', name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(path.join(resources, 'runs.log'))}\necho '${cpuJson}'\n`)
      chmodSync(file, 0o755)
    }
    beforeEach(() => {
      h.packaged = true
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
      writeFileSync(path.join(resources, 'runs.log'), '')
    })
    afterAll(() => rmSync(resources, { recursive: true, force: true }))

    it('ignores SSW_SPEECH_HELPER and runs the probe with the compatible build', async () => {
      writeExe('ssw-speech.exe', '{}')
      writeExe('ssw-speech-compat.exe', JSON.stringify(cpu()))
      expect(speechHelperPaths()?.standard).toBe(path.join(resources, 'native', 'ssw-speech.exe'))
      expect(await selectHelper()).toEqual({ exe: path.join(resources, 'native', 'ssw-speech.exe'), build: 'standard' })
      expect(readFileSync(path.join(resources, 'runs.log'), 'utf8')).toContain('ssw-speech-compat.exe cpu --parent-pid')
    })

    it('AVX2 without BMI2 gets the compatible build; an illegal instruction switches to it for the session', async () => {
      writeExe('ssw-speech.exe', '{}')
      writeExe('ssw-speech-compat.exe', JSON.stringify(cpu({ bmi2: false })))
      expect(await selectHelper()).toMatchObject({ build: 'compatible' })
      resetHelperSelection()
      writeExe('ssw-speech-compat.exe', JSON.stringify(cpu()))
      expect(await selectHelper()).toMatchObject({ build: 'standard' })
      markIllegalInstruction()
      expect(await selectHelper()).toEqual({ exe: path.join(resources, 'native', 'ssw-speech-compat.exe'), build: 'compatible' })
    })

    it('a helper Windows or an antivirus refuses to start is "blocked"', async () => {
      writeExe('ssw-speech.exe', '{}')
      writeExe('ssw-speech-compat.exe', '{}')
      chmodSync(path.join(resources, 'native', 'ssw-speech-compat.exe'), 0o644)
      expect(await selectHelper()).toMatchObject({ error: 'blocked' })
    })
  })
})
