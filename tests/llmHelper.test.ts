import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MARKS_SCHEMA, NAMES_SCHEMA, validateNamesAnswer } from '../src/shared/captions/transcriptText'
import { MIN_ITEMS, schemaGrammar } from '../src/shared/localAi/grammar'
import { cancelLine, loadLine, readHelperLine, runLine, type HelperEvent } from '../src/shared/localAi/protocol'
import { everySchema } from './localAiFixtures'

/*
 * The real helper (docs/design/smart-tools.md §9.1): tests 66, 68 (llama.cpp's own grammar parser),
 * 80 and 128. SSW_LLM_TEST_MODEL names a GGUF file; these tests never download the catalogue's
 * 1.3 to 3.1 GB models: native/llm/README.md names the small pinned test models (llama.cpp's
 * tinyllamas, stories15M-q4_0.gguf, 19,077,344 bytes, SHA-256
 * 66967fbece6dbe97886593fdbb73589584927e29119ec31f08090732d1861739, reads slowly enough to stop it
 * while it reads). SSW_LLM_TEST_HELPER names the helper (default: the host build of native/llm).
 * Under wine on Linux CI and natively on Windows, SSW_LLM_TEST_HELPER names ssw-llm.exe.
 */

const root = path.join(__dirname, '..')
const MODEL = process.env.SSW_LLM_TEST_MODEL ?? ''
const HELPER =
  process.env.SSW_LLM_TEST_HELPER ??
  [path.join(root, 'native', 'llm', 'target', 'host', 'release', 'ssw-llm'), path.join(root, 'native', 'bin', process.platform === 'win32' ? 'ssw-llm.exe' : 'ssw-llm')].find((p) => existsSync(p)) ??
  ''
const ready = !!MODEL && existsSync(MODEL) && !!HELPER && existsSync(HELPER)

/** A helper process speaking the protocol: lines out, events in. */
class Helper {
  readonly child: ChildProcessWithoutNullStreams
  readonly events: HelperEvent[] = []
  private waiters: { test: (e: HelperEvent) => boolean; resolve: (e: HelperEvent) => void }[] = []
  private buffer = ''
  exited: number | null = null
  readonly exit: Promise<number | null>

  constructor(args: string[] = ['--low-priority']) {
    this.child = spawn(HELPER, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8')
      let i: number
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i)
        this.buffer = this.buffer.slice(i + 1)
        const e = readHelperLine(line)
        if (!e) throw new Error(`Not an event: ${line.slice(0, 200)}`)
        this.events.push(e)
        for (const w of [...this.waiters]) {
          if (w.test(e)) {
            this.waiters.splice(this.waiters.indexOf(w), 1)
            w.resolve(e)
          }
        }
      }
    })
    this.exit = new Promise((resolve) => this.child.on('close', (code) => resolve((this.exited = code ?? -1))))
  }

  send(line: string): void {
    this.child.stdin.write(`${line}\n`)
  }

  next(test: (e: HelperEvent) => boolean, ms = 60_000): Promise<HelperEvent> {
    const seen = this.events.find(test)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No such event in time')), ms)
      this.waiters.push({
        test,
        resolve: (e) => {
          clearTimeout(timer)
          resolve(e)
        }
      })
    })
  }

  async load(ctx = 8192): Promise<void> {
    this.send(loadLine(MODEL, ctx, 2))
    const e = await this.next((x) => x.ev === 'loaded' || x.ev === 'error')
    if (e.ev !== 'loaded') throw new Error(`The test model did not load: ${JSON.stringify(e)}`)
  }

  kill(): void {
    if (this.exited === null) this.child.kill('SIGKILL')
  }
}

const helpers: Helper[] = []
const start = (args?: string[]): Helper => {
  const h = new Helper(args)
  helpers.push(h)
  return h
}
afterEach(() => {
  for (const h of helpers.splice(0)) h.kill()
})

/** `tokens --model`: the ids of `parts`, how many are control tokens, and whether `grammar` takes `text`. */
function tokens(parts: { t: string; special: boolean }[], extra: { grammar?: string; text?: string } = {}): { ids: number[]; control: number; accepts?: boolean | string } {
  const r = spawnSync(HELPER, ['tokens', '--model', MODEL], { input: `${JSON.stringify({ parts, ...extra })}\n`, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`tokens failed: ${r.stdout} ${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop()!)
}

const accepts = (grammar: string, text: string): boolean | string => tokens([], { grammar, text }).accepts!

/** A prompt of about `n` tokens of plain words. */
const words = (n: number): string => Array.from({ length: Math.ceil(n / 10) }, () => 'the cat sat on the mat and looked at it').join(' ')

// Under wine every start of the helper boots wine first: the tests get a minute each.
describe.runIf(ready)('the real helper (tests 66, 68, 80, 128)', { timeout: 60_000 }, () => {
  it('loads the model and answers a names request under its grammar with valid JSON (test 66)', async () => {
    const h = start()
    await h.load()
    const grammar = schemaGrammar(NAMES_SCHEMA, { string: 80, minItems: MIN_ITEMS })
    h.send(runLine('r1', [{ t: 'Items: name the step "Click Export".', special: false }], grammar, 300))
    const done = await h.next((e) => e.ev === 'done' || e.ev === 'error')
    expect(done.ev).toBe('done')
    if (done.ev !== 'done') return
    const answer = JSON.parse(done.text) as { names: { id: string; name: string }[] }
    expect(Array.isArray(answer.names)).toBe(true)
    expect(answer.names.length).toBeGreaterThanOrEqual(1)
    for (const n of answer.names) expect(n.name.length).toBeLessThanOrEqual(80)
    expect(done.prompt).toBeGreaterThan(5)
  })

  it('samples at most 2 ms a token under the largest task grammar (test 66)', async () => {
    const h = start()
    await h.load(2048)
    const largest = everySchema()
      .map((s) => schemaGrammar(s.schema, { minItems: MIN_ITEMS }))
      .sort((a, b) => b.length - a.length)[0]
    expect(largest).toBe(schemaGrammar(MARKS_SCHEMA, { minItems: MIN_ITEMS }))
    h.send(runLine('r1', [{ t: 'Captions: click the export button.', special: false }], largest, 200))
    const done = await h.next((e) => e.ev === 'done' || e.ev === 'error')
    expect(done.ev).toBe('done')
    const line = JSON.stringify(h.events.find((e) => e.ev === 'done'))
    // sampleMs is the helper's diagnostic beside the protocol's fields; readHelperLine keeps only those.
    expect(line).not.toContain('sampleMs')
    const raw = await rawDone(largest)
    expect(raw.output).toBeGreaterThan(0)
    expect(raw.sampleMs / raw.output).toBeLessThanOrEqual(2)
  })

  it('stops within 0.6 s when cancelled while it reads a 3,000-token prompt (test 66)', async () => {
    const h = start()
    await h.load()
    h.send(runLine('r1', [{ t: words(3000), special: false }], 'root ::= "{}"', 8))
    const first = await h.next((e) => e.ev === 'read')
    expect(first.ev === 'read' && first.done < first.total).toBe(true)
    const t0 = performance.now()
    h.send(cancelLine('r1'))
    const end = await h.next((e) => e.ev === 'cancelled' || e.ev === 'done')
    const took = performance.now() - t0
    expect(end.ev).toBe('cancelled')
    expect(took).toBeLessThan(600)
    const reads = h.events.filter((e) => e.ev === 'read')
    const last = reads[reads.length - 1]
    expect(last.ev === 'read' && last.done < last.total).toBe(true)
    // It goes on answering the next request.
    h.send(runLine('r2', [{ t: 'Once upon a time', special: false }], 'root ::= "{}"', 8))
    expect((await h.next((e) => e.ev === 'done' || e.ev === 'error')).ev).toBe('done')
  })

  it('exits within 1 s when stdin closes in the middle of a request (tests 66 and 128)', async () => {
    const h = start()
    await h.load()
    h.send(runLine('r1', [{ t: words(3000), special: false }], 'root ::= "{}"', 8))
    await h.next((e) => e.ev === 'read')
    const t0 = performance.now()
    h.child.stdin.end()
    await h.exit
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(h.events.some((e) => e.ev === 'done')).toBe(false)
  })

  // The parent watch needs the helper to be the parent's own child: under wine (SSW_LLM_TEST_WINE)
  // it is a Windows process that cannot see Linux pids, so it is checked natively.
  it.runIf(process.platform === 'linux' && !process.env.SSW_LLM_TEST_WINE)('exits within 2 s after the process named by --parent-pid is killed (test 128)', async () => {
    // A parent that starts the helper with its own pid, prints the helper's pid, and waits.
    const script = `const { spawn } = require('node:child_process'); const c = spawn(${JSON.stringify(HELPER)}, ['--low-priority', '--parent-pid', String(process.pid)], { stdio: ['pipe', 'ignore', 'ignore'] }); console.log(c.pid); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = await new Promise<number>((resolve) => parent.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))))
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)
    const t0 = performance.now()
    parent.kill('SIGKILL')
    while (alive() && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20))
    expect(alive()).toBe(false)
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  it('makes no control token from the vocabulary’s own control strings in a part that is not special (test 66)', () => {
    // The test model's control and user-defined tokens (llama's <s>, </s>, <unk>) and the pinned families' strings.
    const strings = ['<s>', '</s>', '<unk>', '<|im_start|>', '<|im_end|>', '</think>', '<|turn>', '<turn|>']
    const plain = tokens([{ t: strings.join(' '), special: false }])
    expect(plain.control).toBe(0)
    // The same strings in a special part do make control tokens: the check is real.
    const asSpecial = tokens([{ t: '<s></s>', special: true }])
    expect(asSpecial.control).toBeGreaterThan(0)
  })

  it('llama.cpp’s parser accepts every task’s grammar, which takes only an answer that starts with { (test 68)', () => {
    for (const { name, schema } of everySchema()) {
      const g = schemaGrammar(schema, { minItems: MIN_ITEMS })
      const verdict = accepts(g, '{')
      // `{` alone is a prefix, not an answer: false, never "refused".
      expect(verdict, name).toBe(false)
    }
    const names = schemaGrammar(NAMES_SCHEMA, { string: 80, minItems: MIN_ITEMS })
    expect(accepts(names, '{"names":[{"id":"a","name":"Click Export"}]}')).toBe(true)
    expect(accepts(names, ' {"names":[{"id":"a","name":"Click Export"}]}')).toBe(false)
    expect(accepts(names, 'Sure! {"names":[{"id":"a","name":"Click Export"}]}')).toBe(false)
    expect(accepts(names, '{"names":[]}')).toBe(false)
    expect(accepts(names, `{"names":[{"id":"a","name":"${'x'.repeat(80)}"}]}`)).toBe(true)
    expect(accepts(names, `{"names":[{"id":"a","name":"${'x'.repeat(81)}"}]}`)).toBe(false)
    expect(accepts('root ::= [', '{')).toMatch(/refused/)
  })

  it('a Bangla name with conjuncts and a "।" goes through the grammar and comes back intact (test 80)', () => {
    const name = 'রপ্তানি ক্লিক করুন, তারপর সংরক্ষণ করুন।'
    const answer = `{"names":[{"id":"a","name":"${name}"}]}`
    expect(accepts(schemaGrammar(NAMES_SCHEMA, { string: 80, minItems: MIN_ITEMS }), answer)).toBe(true)
    expect(validateNamesAnswer(JSON.parse(answer), { kind: 'step', items: [{ id: 'a', text: 'x' }] })).toEqual([{ id: 'a', name }])
  })
})

/** One run of `grammar` with the helper's raw done line (its sampleMs included). */
async function rawDone(grammar: string): Promise<{ output: number; sampleMs: number }> {
  const child = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stdin.write(`${loadLine(MODEL, 2048, 2)}\n${runLine('r1', [{ t: 'Captions: click the export button.', special: false }], grammar, 200)}\n`)
  for (let i = 0; i < 600 && !out.includes('"ev":"done"'); i++) await new Promise((r) => setTimeout(r, 100))
  child.kill('SIGKILL')
  const line = out.split('\n').find((l) => l.includes('"ev":"done"'))
  if (!line) throw new Error(`No answer: ${out.slice(0, 300)}`)
  return JSON.parse(line) as { output: number; sampleMs: number }
}

describe.runIf(!ready)('the real helper', () => {
  it('needs SSW_LLM_TEST_MODEL and a built helper (native/llm/README.md)', () => {
    expect(ready).toBe(false)
  })
})
