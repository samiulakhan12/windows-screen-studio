/**
 * The engine of AI on this PC (src/main/localAi/engine.ts, docs/design/smart-tools.md §9.2, §22
 * test 65) against the fake helper (tests/fixtures/fake-llm-helper.cjs): one request at a time,
 * the second waiting; Stop sends `cancel` and kills after the grace without `cancelled`; the
 * watchdog; the idle unload; a crash failing its request and the next starting a new helper; the
 * arguments as a list starting with `--low-priority --parent-pid <pid>`; every stdout line read
 * strictly. And test 79's messages for what the helper reports.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAiProgress } from '../src/shared/api/localAi'

const h = vi.hoisted(() => ({ packaged: false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getAppPath: () => require('node:path').resolve(__dirname, '..'),
    getPath: (name: string) => require('node:path').join(require('node:os').tmpdir(), name)
  }
}))

import { LlmEngine, llmCommand, llmEnv, llmHelperPath, LLM_TIMING, LocalAiError } from '../src/main/localAi/engine'
import { LOCAL_MODELS } from '../src/shared/localAi/catalog'
import { chatParts } from '../src/shared/localAi/chatFormat'
import { LOCAL_MESSAGES } from '../src/shared/localAi/messages'

const FAKE = path.resolve(__dirname, 'fixtures/fake-llm-helper.cjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'ssw-llm-engine-'))
const logFile = path.join(dir, 'calls.jsonl')
const spec = LOCAL_MODELS[1]
const grammar = 'root ::= answer-0\nanswer-0 ::= "{" ws "\\"text\\"" ws ":" ws string ws "}"\n'

type Logged = { start?: true; args?: string[]; cwd?: string; env?: string[]; pid?: number; line?: { op: string; id?: string; model?: string } }
const logged = (): Logged[] =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged)
const starts = (): Logged[] => logged().filter((l) => l.start)
const lines = (op: string): Logged['line'][] =>
  logged()
    .map((l) => l.line)
    .filter((l) => l?.op === op)

const ENV = ['FAKE_LLM_MODE', 'FAKE_LLM_STEP_MS', 'FAKE_LLM_LOAD_MS', 'FAKE_LLM_TOKENS', 'FAKE_LLM_LOG', 'FAKE_LLM_ANSWER']
let engines: LlmEngine[] = []
beforeEach(() => {
  h.packaged = false
  process.env.FAKE_LLM_LOG = logFile
  writeFileSync(logFile, '')
})
afterEach(async () => {
  for (const e of engines.splice(0)) await e.dispose()
  for (const k of ENV) delete process.env[k]
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const engine = (opts: { idleMs?: number; graceMs?: number; stallMs?: number } = {}): LlmEngine => {
  const e = new LlmEngine({ helper: FAKE, dir, ...opts })
  engines.push(e)
  return e
}

const request = (signal = new AbortController().signal, onProgress: (p: LocalAiProgress) => void = () => undefined) => ({
  spec,
  parts: chatParts(spec.family, 'You write titles.', 'Transcript:\n{"segments":[]}'),
  grammar,
  maxTokens: 80,
  signal,
  onProgress
})

const waitFor = async (test: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now()
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('LlmEngine with a fake helper (test 65)', () => {
  it('answers a request: loads the model, reads, writes, and reports each phase with the time left', async () => {
    const e = engine()
    const seen: LocalAiProgress[] = []
    const answer = await e.run(request(undefined, (p) => seen.push(p)))
    expect(JSON.parse(answer.text)).toEqual({ text: 'A draft written on this PC.' })
    expect(answer.output).toBe(48)
    expect(seen[0].phase).toBe('loading')
    expect(seen.some((p) => p.phase === 'reading' && p.total > 0 && typeof p.secondsLeft === 'number')).toBe(true)
    const writing = seen.filter((p) => p.phase === 'writing')
    expect(writing.length).toBe(3)
    expect(writing[writing.length - 1]).toMatchObject({ done: 48, total: 80 })
    // The model the catalogue names, in the models folder, with mmap off and 8,192 tokens of context.
    expect(lines('load')).toEqual([expect.objectContaining({ op: 'load', model: path.join(dir, spec.file) })])
    expect(logged().find((l) => l.line?.op === 'load')?.line).toMatchObject({ ctx: 8192, mmap: false })
  })

  it('starts the helper as a list of arguments, --low-priority --parent-pid <pid> first, in the models folder, with a minimal environment', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-never-reach-the-helper'
    try {
      const e = engine()
      await e.run(request())
    } finally {
      delete process.env.OPENAI_API_KEY
    }
    const [start] = starts()
    expect(start.args).toEqual(['--low-priority', '--parent-pid', String(process.pid)])
    expect(start.cwd).toBe(dir)
    expect(start.env).not.toContain('OPENAI_API_KEY')
    expect(start.env!.every((k) => ['PATH', 'LANG'].includes(k))).toBe(true)
    // The real helper: the program itself, no shell, no Node.
    expect(llmCommand('/opt/flown/ssw-llm.exe', false)).toMatchObject({ file: '/opt/flown/ssw-llm.exe', args: ['--low-priority', '--parent-pid', String(process.pid)] })
    expect(llmCommand(FAKE, true).file).toBe(FAKE)
    expect(llmEnv('win32', { SystemRoot: 'C:\\Windows', PATH: 'C:\\x', OPENAI_API_KEY: 'k', TEMP: 't' })).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\x', TEMP: 't' })
  })

  it('runs one request at a time: the second waits ("waiting") and starts when the first is done, in the same helper', async () => {
    process.env.FAKE_LLM_STEP_MS = '20'
    const e = engine()
    const second: LocalAiProgress[] = []
    const a = e.run(request())
    const b = e.run(request(undefined, (p) => second.push(p)))
    expect(second[0]).toEqual({ phase: 'waiting', done: 0, total: 0 })
    let aDone = false
    void a.then(() => (aDone = true))
    await waitFor(() => second.length > 1)
    expect(aDone).toBe(true)
    await Promise.all([a, b])
    expect(starts()).toHaveLength(1)
    const runs = lines('run')
    expect(runs).toHaveLength(2)
    expect(runs[0]!.id).not.toBe(runs[1]!.id)
  })

  it('Stop sends cancel and ends with "Stopped."; a waiting request ends at once without reaching the helper', async () => {
    process.env.FAKE_LLM_STEP_MS = '30'
    const e = engine()
    const stop = new AbortController()
    const stopWaiting = new AbortController()
    const a = e.run(request(stop.signal))
    const b = e.run(request(stopWaiting.signal))
    stopWaiting.abort()
    await expect(b).rejects.toThrow(LOCAL_MESSAGES.stopped)
    await waitFor(() => lines('run').length === 1)
    stop.abort()
    const err = await a.catch((x: unknown) => x)
    expect(err).toBeInstanceOf(LocalAiError)
    expect((err as LocalAiError).code).toBe('stopped')
    expect((err as Error).message).toBe('Stopped.')
    expect(lines('cancel')).toEqual([{ op: 'cancel', id: lines('run')[0]!.id }])
    expect(lines('run')).toHaveLength(1)
    // The helper stays: the next request uses it.
    await e.run(request())
    expect(starts()).toHaveLength(1)
  })

  it('kills the helper when no cancelled comes within the grace (2,000 ms by default), and the next request starts a new one', async () => {
    expect(LLM_TIMING.graceMs).toBe(2000)
    process.env.FAKE_LLM_MODE = 'ignore-cancel'
    process.env.FAKE_LLM_STEP_MS = '30'
    const e = engine({ graceMs: 200 })
    const stop = new AbortController()
    const a = e.run(request(stop.signal))
    await waitFor(() => lines('run').length === 1)
    const t0 = Date.now()
    stop.abort()
    await expect(a).rejects.toThrow('Stopped.')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    const pid = starts()[0].pid!
    await waitFor(() => !alive(pid))
    delete process.env.FAKE_LLM_MODE
    await e.run(request())
    expect(starts()).toHaveLength(2)
  })

  it('kills the helper when it says nothing for 120 s while a request runs (the watchdog)', async () => {
    expect(LLM_TIMING.stallMs).toBe(120_000)
    process.env.FAKE_LLM_MODE = 'stall'
    const e = engine({ stallMs: 200 })
    const err = await e.run(request()).catch((x: unknown) => x)
    expect((err as LocalAiError).code).toBe('stalled')
    expect((err as Error).message).toBe('AI on this PC stopped responding. Try again.')
    await waitFor(() => !alive(starts()[0].pid!))
  })

  it('the watchdog starts again when the PC resumes from sleep: the time it slept never ends a running request', async () => {
    process.env.FAKE_LLM_MODE = 'stall'
    const e = engine({ stallMs: 600 })
    let failed: unknown = null
    const run = e.run(request()).catch((x: unknown) => (failed = x))
    await waitFor(() => lines('run').length === 1)
    // Resumes keep coming before the watchdog would fire: the request goes on past three times its stall.
    const t0 = Date.now()
    while (Date.now() - t0 < 1800) {
      e.resetWatchdogs()
      await new Promise((r) => setTimeout(r, 100))
      expect(failed).toBeNull()
    }
    expect(starts()).toHaveLength(1)
    // No resume and no line: the watchdog ends it as before.
    await run
    expect((failed as LocalAiError).code).toBe('stalled')
  })

  it('unloads after 120 s without a request: the helper exits and gives its memory back; the next request starts a new one', async () => {
    expect(LLM_TIMING.idleMs).toBe(120_000)
    const e = engine({ idleMs: 150 })
    await e.run(request())
    const pid = starts()[0].pid!
    expect(e.loadedModel).toBe(path.join(dir, spec.file))
    await waitFor(() => !alive(pid))
    expect(e.loadedModel).toBeNull()
    await e.run(request())
    expect(starts()).toHaveLength(2)
  })

  it('loadFinished: false while the helper loads the model, true once it said `loaded`, false once it is gone', async () => {
    process.env.FAKE_LLM_LOAD_MS = '300'
    const e = engine({ idleMs: 150 })
    expect(e.loadFinished).toBe(false)
    const run = e.run(request())
    expect(e.loadedModel).toBe(path.join(dir, spec.file))
    expect(e.loadFinished).toBe(false)
    await run
    expect(e.loadFinished).toBe(true)
    await waitFor(() => e.loadedModel === null)
    expect(e.loadFinished).toBe(false)
  })

  it('a crash fails the request with §9.9’s words, and the next request starts a new helper', async () => {
    process.env.FAKE_LLM_MODE = 'crash'
    const e = engine()
    const err = await e.run(request()).catch((x: unknown) => x)
    expect((err as LocalAiError).code).toBe('crashed')
    expect((err as Error).message).toBe('AI on this PC stopped unexpectedly. Try again, or use the Small model.')
    delete process.env.FAKE_LLM_MODE
    await e.run(request())
    expect(starts()).toHaveLength(2)
  })

  it.each([
    ['garbage', 'a line that is not an event'],
    ['overflow', 'a line over 4 MB']
  ])('%s (%s) ends the job and the helper', async (mode) => {
    process.env.FAKE_LLM_MODE = mode
    const e = engine()
    const err = await e.run(request()).catch((x: unknown) => x)
    expect((err as LocalAiError).code).toBe('crashed')
    await waitFor(() => !alive(starts()[0].pid!))
  })

  it('unload stops a running request as Stop does and lets the helper go; dispose refuses new requests', async () => {
    process.env.FAKE_LLM_STEP_MS = '30'
    const e = engine()
    const a = e.run(request()).catch((x: unknown) => x)
    await waitFor(() => lines('run').length === 1)
    await e.unload()
    expect(((await a) as Error).message).toBe('Stopped.')
    expect(alive(starts()[0].pid!)).toBe(false)
    await e.dispose()
    await expect(e.run(request())).rejects.toThrow('Stopped.')
  })

  it('a request for another model starts another helper (one model a process)', async () => {
    const e = engine()
    await e.run(request())
    await e.run({ ...request(), spec: LOCAL_MODELS[0] })
    expect(starts()).toHaveLength(2)
    expect(lines('load').map((l) => l!.model)).toEqual([path.join(dir, LOCAL_MODELS[1].file), path.join(dir, LOCAL_MODELS[0].file)])
  })
})

describe('what the helper reports, in §9.9’s words (test 79)', () => {
  it.each([
    ['context', 'context', 'This text is too long for AI on this PC: shorten it or use an AI service.'],
    ['memory', 'memory', 'AI on this PC stopped unexpectedly. Try again, or use the Small model.'],
    ['load-error', 'model', 'The model file is missing or damaged. Download it again in Settings › AI on this PC.']
  ])('%s', async (mode, code, message) => {
    process.env.FAKE_LLM_MODE = mode
    const err = await engine()
      .run(request())
      .catch((x: unknown) => x)
    expect(err).toBeInstanceOf(LocalAiError)
    expect((err as LocalAiError).code).toBe(code)
    expect((err as Error).message).toBe(message)
  })
})

describe('llmHelperPath (test 104)', () => {
  afterEach(() => {
    delete process.env.SSW_LLM_HELPER
  })

  it('takes SSW_LLM_HELPER only when the app is not packaged', () => {
    process.env.SSW_LLM_HELPER = FAKE
    expect(llmHelperPath()).toBe(FAKE)
    h.packaged = true
    const resources = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true })
    try {
      // Packaged: the bundled helper beside the speech helpers, or none; never the variable's file.
      expect(llmHelperPath()).toBeNull()
      mkdirSync(path.join(dir, 'native'), { recursive: true })
      writeFileSync(path.join(dir, 'native', 'ssw-llm.exe'), '')
      expect(llmHelperPath()).toBe(path.join(dir, 'native', 'ssw-llm.exe'))
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    }
  })

  it('a missing override gives no helper (never a path that is not a file)', () => {
    process.env.SSW_LLM_HELPER = path.join(dir, 'nothing-here')
    expect(llmHelperPath()).toBeNull()
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
