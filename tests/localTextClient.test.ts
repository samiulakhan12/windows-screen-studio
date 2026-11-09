/**
 * AI on this PC as an AiClient (src/main/localAi/localTextClient.ts, docs/design/smart-tools.md
 * §9.2, §9.6, §22 tests 69, 73, 74, 79 and 129): progress to the page that asked, by its request id,
 * with the time left; a run expected over 10 s is a long job of the kind 'ai'; an answer cut off at
 * its room is tried once more with 1.5 times the room; 'chapters' and 'marks' never run here; the
 * grammar bounds names; the model a run uses, or §9.5's and §9.9's words when none can run; and,
 * through the app's own `ai:text` channel with the fake helper, a reload of the page stops the run.
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userData: '', handlers: new Map<string, (...args: unknown[]) => unknown>(), power: new Map<string, () => void>() }))
h.userData = mkdtempSync(path.join(os.tmpdir(), 'w11-local-client-'))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false, on: () => undefined, getAppPath: () => '/nonexistent', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), getSelectedStorageBackend: () => 'dpapi' },
  net: { request: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: (event: string, fn: () => void) => void h.power.set(event, fn) }
}))
vi.mock('../src/main/ai/transcribe', () => ({ stopAllTranscriptions: () => undefined, stopTranscription: () => undefined, sweepTranscribeTemp: async () => undefined, transcribeProject: async () => undefined }))

import type { LlmAnswer } from '../src/main/localAi/engine'
import { localTextClient, makeLocalClient, setLocalEngine } from '../src/main/localAi/localTextClient'
import { configureLocalModels, localAiState } from '../src/main/localAi/models'
import { processorOk, registerLocalAiIpc } from '../src/main/localAi/localAiIpc'
import { registerAiIpc } from '../src/main/aiIpc'
import { LOCAL_AI_CHANNELS, type LocalAiProgress } from '../src/shared/api/localAi'
import { AiOutputError, textPrompts, type TextPrompt } from '../src/shared/captions/transcriptText'
import { LOCAL_BUDGET, promptTokens, SCRIPT_MAX_TOKENS } from '../src/shared/localAi/budget'
import { LOCAL_MODELS, type LocalModelSpec } from '../src/shared/localAi/catalog'
import { LOCAL_MESSAGES } from '../src/shared/localAi/messages'
import { scriptPrompt } from '../src/shared/notes/scriptDraft'

const FAKE = path.resolve(__dirname, 'fixtures/fake-llm-helper.cjs')
afterAll(() => rmSync(h.userData, { recursive: true, force: true }))

const small = LOCAL_MODELS[1]
const seg = (i: number, text: string) => ({ id: `s${i}`, start: i, end: i + 1, text })
const titlePrompt = (): TextPrompt => textPrompts({ task: 'title', segments: [seg(0, 'Click Export, then Save.')] })[0]

interface Call {
  spec: LocalModelSpec
  parts: readonly { t: string; special: boolean }[]
  grammar: string
  maxTokens: number
  signal: AbortSignal
}

/** A stand-in for the engine: answers from `answers` in turn, reporting `progress` first. */
function fakeEngine(answers: ((c: Call) => Partial<LlmAnswer>)[], progress: LocalAiProgress[] = []) {
  const calls: Call[] = []
  return {
    calls,
    loadedModel: null as string | null,
    loadFinished: false,
    async run(req: Call & { onProgress(p: LocalAiProgress): void }): Promise<LlmAnswer> {
      calls.push(req)
      for (const p of progress) req.onProgress(p)
      const next = answers[Math.min(calls.length - 1, answers.length - 1)](req)
      return { text: '{"text":"A title"}', prompt: 300, output: 20, readMs: 1000, writeMs: 2000, ...next }
    }
  }
}

function fakePage() {
  const sent: { channel: string; p: LocalAiProgress }[] = []
  return { sent, sender: { send: (channel: string, p: LocalAiProgress) => sent.push({ channel, p }), isDestroyed: () => false } }
}

function fakeJobs() {
  const jobs: { kind: string; onStop?: () => void; updates: unknown[]; ends: unknown[] }[] = []
  const beginJob = (spec: { kind: string; onStop?: () => void }) => {
    const job = { kind: spec.kind, onStop: spec.onStop, updates: [] as unknown[], ends: [] as unknown[] }
    jobs.push(job)
    return { id: 'j', update: (u: unknown) => void job.updates.push(u), end: async (o: unknown) => void job.ends.push(o) }
  }
  return { jobs, beginJob: beginJob as never }
}

const opts = (signal = new AbortController().signal) => ({ signal, effort: 'low' as const })

describe('progress and long jobs (test 73)', () => {
  it('progress goes to the page that asked, by its request id, with the time left; a phase change at once, the rest at most every 250 ms', async () => {
    const engine = fakeEngine(
      [() => ({})],
      [
        { phase: 'loading', done: 0, total: 0, secondsLeft: 30 },
        { phase: 'reading', done: 64, total: 640, secondsLeft: 20 },
        { phase: 'reading', done: 128, total: 640, secondsLeft: 19 },
        { phase: 'writing', done: 16, total: 80, secondsLeft: 9 }
      ]
    )
    const page = fakePage()
    const client = makeLocalClient({ engine, spec: small, sender: page.sender as never, requestId: 'req-7', beginJob: fakeJobs().beginJob })
    await client.json(titlePrompt(), opts())
    expect(page.sent.map((s) => s.channel)).toEqual([LOCAL_AI_CHANNELS.progress, LOCAL_AI_CHANNELS.progress, LOCAL_AI_CHANNELS.progress])
    expect(page.sent.map((s) => s.p)).toEqual([
      { phase: 'loading', done: 0, total: 0, secondsLeft: 30, requestId: 'req-7' },
      { phase: 'reading', done: 64, total: 640, secondsLeft: 20, requestId: 'req-7' },
      { phase: 'writing', done: 16, total: 80, secondsLeft: 9, requestId: 'req-7' }
    ])
  })

  it('a page that is gone hears nothing', async () => {
    const engine = fakeEngine([() => ({})], [{ phase: 'reading', done: 1, total: 2 }])
    const sent: unknown[] = []
    const client = makeLocalClient({ engine, spec: small, sender: { send: (...a: unknown[]) => sent.push(a), isDestroyed: () => true } as never, requestId: 'r1', beginJob: fakeJobs().beginJob })
    await client.json(titlePrompt(), opts())
    expect(sent).toEqual([])
  })

  it('a request expected to take more than 10 s is a long job of the kind ai, with progress, Stop on the thumbnail and its end', async () => {
    let seen: AbortSignal | null = null
    const engine = fakeEngine([(c) => ((seen = c.signal), {})], [{ phase: 'reading', done: 300, total: 600 }])
    const jobs = fakeJobs()
    // Small writes 8 tokens a second: a title's 80 tokens of room alone take 10 s, and the model is not loaded yet.
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, requestId: 'r', beginJob: jobs.beginJob })
    await client.json(titlePrompt(), opts())
    expect(jobs.jobs).toHaveLength(1)
    expect(jobs.jobs[0]).toMatchObject({ kind: 'ai', updates: [{ fraction: 0.5 }], ends: [{ kind: 'done' }] })
    // Stop on the thumbnail stops the request.
    jobs.jobs[0].onStop!()
    expect(seen!.aborted).toBe(true)
  })

  it('a short request is not a long job', async () => {
    const fast = { ...small, read: 5000, write: 500, loadS: 0.1 }
    const engine = fakeEngine([() => ({})])
    engine.loadedModel = `/models/${fast.file}`
    const jobs = fakeJobs()
    await makeLocalClient({ engine, spec: fast, sender: fakePage().sender as never, beginJob: jobs.beginJob }).json(titlePrompt(), opts())
    expect(jobs.jobs).toEqual([])
  })

  it('the speeds of a finished request are handed on to be blended (§9.8)', async () => {
    const speeds: [number, number][] = []
    const engine = fakeEngine([() => ({ prompt: 600, output: 40, readMs: 2000, writeMs: 5000 })])
    await makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob, onSpeeds: (r, w) => speeds.push([r, w]) }).json(titlePrompt(), opts())
    expect(speeds).toEqual([[300, 8]])
  })
})

describe('the room of an answer (test 69)', () => {
  it('an answer cut off at its room is tried once more with 1.5 times the room', async () => {
    const engine = fakeEngine([(c) => ({ text: '{"text":"A ti', output: c.maxTokens }), () => ({ text: '{"text":"A title"}', output: 30 })])
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    expect(await client.json(titlePrompt(), opts())).toEqual({ text: 'A title' })
    expect(engine.calls.map((c) => c.maxTokens)).toEqual([80, 120])
  })

  it('cut off twice: the check fails ("Nothing was changed"), never a third try', async () => {
    const engine = fakeEngine([(c) => ({ text: '{"text":"A ti', output: c.maxTokens })])
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    const err = await client.json(titlePrompt(), opts()).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(AiOutputError)
    expect((err as Error).message).toBe("The AI's answer could not be used (it was cut off). Nothing was changed; try again.")
    expect(engine.calls).toHaveLength(2)
  })

  it('the prompt and its room stay within the context less one batch', async () => {
    const long = textPrompts({ task: 'cleanup', segments: Array.from({ length: 40 }, (_, i) => seg(i, 'word '.repeat(14))) })[0]
    const engine = fakeEngine([() => ({ text: '{"segments":[]}' })])
    await makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob }).json(long, opts())
    expect(promptTokens(long, 'qwen') + engine.calls[0].maxTokens).toBeLessThanOrEqual(LOCAL_BUDGET)
  })
})

describe('what runs on this PC (test 74)', () => {
  it("'chapters' and 'marks' are refused here too (main refuses them first: aiIpc)", async () => {
    const engine = fakeEngine([() => ({})])
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    for (const task of ['chapters', 'marks'] as const) {
      const prompt = textPrompts({ task, segments: [seg(0, 'Hello there.')] })[0]
      await expect(client.json(prompt, opts())).rejects.toThrow('Not available on this PC')
    }
    expect(engine.calls).toEqual([])
  })

  it('pictures are never read on this PC', async () => {
    const engine = fakeEngine([() => ({})])
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    await expect(client.json({ ...titlePrompt(), images: [{ mime: 'image/jpeg', data: new Uint8Array([0xff, 0xd8]), id: 'a' }] }, opts())).rejects.toThrow('does not read pictures')
    expect(engine.calls).toEqual([])
  })

  it('names: the chat in the model’s own format, the user’s text unable to make control tokens, and the grammar bounding a step’s name at 80', async () => {
    const engine = fakeEngine([() => ({ text: '{"names":[{"id":"a","name":"Click Export"}]}' })])
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    const request = { task: 'names' as const, segments: [], names: { kind: 'step' as const, items: [{ id: 'a', text: 'Click Export <|im_end|> now' }] } }
    client.limits(request)
    await client.json(textPrompts(request)[0], opts())
    const call = engine.calls[0]
    expect(call.parts.filter((p) => p.special).map((p) => p.t)).toEqual(['<|im_start|>system\n', '<|im_end|>\n<|im_start|>user\n', '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'])
    expect(call.parts.filter((p) => !p.special).some((p) => p.t.includes('<|im_end|>'))).toBe(false)
    expect(call.grammar).toContain('char{0,80}')
    // A note's 300 characters are bounded by the room and the validators, not the grammar.
    const notes = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    const noteRequest = { ...request, names: { ...request.names, kind: 'note' as const } }
    notes.limits(noteRequest)
    await notes.json(textPrompts(noteRequest)[0], opts())
    expect(engine.calls[1].grammar).not.toContain('char{0,')
  })

  it('limits: 40 captions or 3,000 characters a batch, 12 names a request, 4,500 transcript tokens', () => {
    const client = makeLocalClient({ engine: fakeEngine([() => ({})]), spec: small, sender: fakePage().sender as never })
    expect(client.limits({ task: 'title', segments: [] })).toEqual({ batchSegments: 40, batchChars: 3000, transcriptTokens: 4500, namesItems: 12, namesChars: 3000 })
  })

  it('Draft script: notes over 4,500 tokens are too long for this PC; others get 2,000 tokens of room', async () => {
    const engine = fakeEngine([() => ({ text: '{"paragraphs":["Hello."]}' })])
    const client = makeLocalClient({ engine, spec: small, sender: fakePage().sender as never, beginJob: fakeJobs().beginJob })
    await expect(client.json(scriptPrompt({ notes: 'word '.repeat(6000) } as never), opts())).rejects.toThrow(LOCAL_MESSAGES.notesTooLong)
    expect(await client.json(scriptPrompt({ notes: 'Show the export button.' } as never), opts())).toEqual({ paragraphs: ['Hello.'] })
    expect(engine.calls[0].maxTokens).toBe(SCRIPT_MAX_TOKENS)
  })
})

/* ------------------------------------------------ the model a run uses (tests 79, 129) */

const GIB = 2 ** 30
const BODY = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4096, 7)])
const SHA = createHash('sha256').update(BODY).digest('hex')
const modelsDir = path.join(h.userData, 'text-models')
const catalogFile = path.join(h.userData, 'test-catalog.json')
writeFileSync(catalogFile, JSON.stringify([{ id: 'qwen3.5-2b', file: 'tiny.gguf', bytes: BODY.length, sha256: SHA, url: 'http://127.0.0.1:9/tiny.gguf' }]))

let probes = 0
const pc = { totalMemBytes: 16 * GIB, freeMemBytes: 8 * GIB, helper: true }
let processor: boolean | null = true
beforeEach(() => {
  process.env.SSW_TEXT_MODEL_TEST_CATALOG = catalogFile
  process.env.SSW_LLM_HELPER = FAKE
  processor = true
  pc.freeMemBytes = 8 * GIB
  pc.helper = true
  probes = 0
  configureLocalModels({
    pc: () => ({ ...pc }),
    processor: async () => {
      probes++
      return processor
    }
  })
  setLocalEngine(null)
  rmSync(modelsDir, { recursive: true, force: true })
})

const withModel = (): void => {
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(path.join(modelsDir, 'tiny.gguf'), BODY)
}
const ctx = () => ({ sender: fakePage().sender as never, requestId: 'r1' })

describe('when AI on this PC cannot run (tests 79, 129)', () => {
  it('nothing downloaded', async () => {
    await expect(localTextClient(ctx())).rejects.toThrow(LOCAL_MESSAGES.noModel)
  })

  it('the processor comes from the speech helpers’ probe: null blocks with "Flown could not check this PC’s processor"', async () => {
    withModel()
    processor = null
    await expect(localTextClient(ctx())).rejects.toThrow("Flown could not check this PC's processor.")
    processor = false
    await expect(localTextClient(ctx())).rejects.toThrow("This PC's processor is too old for AI on this PC (it needs AVX2).")
    expect(probes).toBe(2)
  })

  it('no helper in this build', async () => {
    withModel()
    pc.helper = false
    await expect(localTextClient(ctx())).rejects.toThrow('AI on this PC is not part of this build.')
  })

  it('free memory under the peak refuses the run with §9.5’s message', async () => {
    withModel()
    pc.freeMemBytes = 1.5 * GIB
    await expect(localTextClient(ctx())).rejects.toThrow('AI on this PC needs about 2.2 GB of free memory and 1.5 GB is free. Close some apps.')
  })

  it('a damaged file is never handed to the helper', async () => {
    mkdirSync(modelsDir, { recursive: true })
    writeFileSync(path.join(modelsDir, 'tiny.gguf'), Buffer.from('nope'))
    await expect(localTextClient(ctx())).rejects.toThrow(LOCAL_MESSAGES.noModel)
  })
})

describe('the processor (test 129)', () => {
  const cpu = (over: Record<string, boolean> = {}) => ({ type: 'cpu', sse42: true, avx: true, avx2: true, fma: true, f16c: true, bmi2: true, logical: 8, ...over })

  it('comes only from the speech helpers’ probe, run once when it has not run yet', async () => {
    let probed: ReturnType<typeof cpu> | null = null
    let runs = 0
    const probe = async () => {
      runs++
      probed = cpu()
    }
    expect(await processorOk(probe, () => probed as never)).toBe(true)
    expect(await processorOk(probe, () => probed as never)).toBe(true)
    expect(runs).toBe(1)
  })

  it('AVX2, FMA and F16C are all needed; a failed probe is null ("could not check")', async () => {
    for (const missing of ['avx2', 'fma', 'f16c']) expect(await processorOk(async () => undefined, () => cpu({ [missing]: false }) as never)).toBe(false)
    expect(await processorOk(async () => Promise.reject(new Error('no helper')), () => null)).toBeNull()
  })
})

describe("aiText('local') through the app's channel, with the fake helper (tests 73, 129)", () => {
  registerAiIpc()
  const APP = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
  const page = () => {
    const sent: { channel: string; p: LocalAiProgress }[] = []
    const sender = Object.assign(new EventEmitter(), { send: (channel: string, p: LocalAiProgress) => void sent.push({ channel, p }), isDestroyed: () => false, id: 1 })
    return { sent, sender, event: { sender, senderFrame: { url: APP } } }
  }
  const summary = { task: 'summary', segments: [seg(0, 'We open the billing page and export the report as a PDF.')] }
  const logFile = path.join(h.userData, 'llm.jsonl')

  it('answers with the model a run uses; its progress reaches the page that asked, by request id; ssw-llm is never started before a run', async () => {
    withModel()
    writeFileSync(logFile, '')
    process.env.FAKE_LLM_LOG = logFile
    try {
      const p = page()
      // Settings reads the state (the processor included) without starting the helper.
      expect((await localAiState()).models.find((m) => m.id === 'qwen3.5-2b')?.state).toBe('ready')
      expect(readFileSync(logFile, 'utf8')).toBe('')
      const result = await h.handlers.get('ai:text')!(p.event, 'local', summary, 'sum-1')
      expect(result).toEqual({ task: 'summary', text: 'A draft written on this PC.', model: 'qwen3.5-2b' })
      const progress = p.sent.filter((s) => s.channel === LOCAL_AI_CHANNELS.progress).map((s) => s.p)
      expect(progress.length).toBeGreaterThan(0)
      expect(progress.every((x) => x.requestId === 'sum-1')).toBe(true)
      expect(progress.some((x) => typeof x.secondsLeft === 'number')).toBe(true)
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { start?: true; line?: { op: string; model?: string } })
      expect(lines.filter((l) => l.start)).toHaveLength(1)
      expect(lines.find((l) => l.line?.op === 'load')?.line?.model).toBe(path.join(modelsDir, 'tiny.gguf'))
    } finally {
      delete process.env.FAKE_LLM_LOG
    }
  })

  it('a reload of the page that asked stops its run', async () => {
    withModel()
    process.env.FAKE_LLM_STEP_MS = '40'
    try {
      const p = page()
      const run = Promise.resolve(h.handlers.get('ai:text')!(p.event, 'local', summary, 'sum-2')).catch((x: unknown) => x)
      await vi.waitFor(() => expect(p.sent.some((s) => s.p.phase === 'reading' || s.p.phase === 'writing')).toBe(true), { timeout: 5000 })
      p.sender.emit('did-navigate')
      expect(((await run) as Error).message).toBe('Stopped.')
    } finally {
      delete process.env.FAKE_LLM_STEP_MS
    }
  })
})

describe('the helper as the app runs it (§9.2, §9.5, §9.9)', () => {
  let registered = false
  const register = (): void => {
    if (registered) return
    registered = true
    registerLocalAiIpc()
    configureLocalModels({ pc: () => ({ ...pc }), processor: async () => processor })
  }

  it('counts the memory the helper holds as free: the next run uses the same model and the state says so', async () => {
    register()
    withModel()
    const engine = fakeEngine([() => ({})])
    setLocalEngine(engine as never)
    pc.freeMemBytes = 3.5 * GIB
    const first = await localTextClient(ctx())
    expect(first.model).toBe('qwen3.5-2b')
    await first.json(titlePrompt(), opts())
    // The helper keeps the model: the free memory falls by its peak.
    engine.loadedModel = path.join(modelsDir, 'tiny.gguf')
    engine.loadFinished = true
    pc.freeMemBytes = 3.5 * GIB - small.peakMB * 2 ** 20
    const second = await localTextClient(ctx())
    expect(second.model).toBe('qwen3.5-2b')
    const state = await localAiState()
    expect(state.active).toBe('qwen3.5-2b')
    expect(state.pc.freeMemBytes).toBe(3.5 * GIB)
    // A file the helper holds that is not the model on disk adds nothing.
    engine.loadedModel = path.join(h.userData, 'elsewhere', 'tiny.gguf')
    await expect(localTextClient(ctx())).rejects.toThrow('AI on this PC needs about 2.2 GB of free memory and 1.3 GB is free. Close some apps.')
  })

  it('while the helper still loads its model, that memory is not free for a bigger one: the next run waits for the same model', async () => {
    register()
    const both = path.join(h.userData, 'test-catalog-both.json')
    const entry = { bytes: BODY.length, sha256: SHA, url: 'http://127.0.0.1:9/m.gguf' }
    writeFileSync(both, JSON.stringify([{ id: 'gemma4-e2b', file: 'big.gguf', ...entry }, { id: 'qwen3.5-2b', file: 'tiny.gguf', ...entry }]))
    process.env.SSW_TEXT_MODEL_TEST_CATALOG = both
    withModel()
    writeFileSync(path.join(modelsDir, 'big.gguf'), BODY)
    const engine = fakeEngine([() => ({})])
    setLocalEngine(engine as never)
    // A first tool took Small (Recommended's 3.8 GB did not fit) and the helper is loading it: most
    // of its memory is not taken yet, so Recommended would not fit once Small is let go either.
    engine.loadedModel = path.join(modelsDir, 'tiny.gguf')
    pc.freeMemBytes = 1.8 * GIB
    expect((await localTextClient(ctx())).model).toBe('qwen3.5-2b')
    expect((await localAiState()).active).toBe('qwen3.5-2b')
    // Loaded: Small holds its 2.2 GB, which the helper gives back before Recommended loads.
    engine.loadFinished = true
    expect((await localTextClient(ctx())).model).toBe('gemma4-e2b')
  })

  it('the PC resuming from sleep starts the watchdog of a running request again', () => {
    register()
    let resets = 0
    setLocalEngine({ resetWatchdogs: () => void resets++ } as never)
    h.power.get('resume')!()
    expect(resets).toBe(1)
    setLocalEngine(null)
    h.power.get('resume')!()
    expect(resets).toBe(1)
  })
})
