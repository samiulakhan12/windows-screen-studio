#!/usr/bin/env node
// Stand-in for native/bin/ssw-llm that speaks the protocol of src/shared/localAi/protocol.ts
// (docs/design/smart-tools.md §9.1): JSON lines on stdin (`load`, `run`, `cancel`) and stdout
// (`loaded`, `read`, `write`, `done`, `cancelled`, `error`). Used through SSW_LLM_HELPER (read only
// when the app is not packaged) by tests/llmEngine.test.ts and the e2e run of AI on this PC; the
// engine starts a .cjs helper under Node with the FAKE_LLM_* variables.
//
// Its answer: FAKE_LLM_ANSWER (raw text) when set; else made from the grammar's first key: `text`
// (titles, summaries, posts) "A draft written on this PC."; `names` one name for each item of the
// prompt's data block; `segments` the prompt's captions unchanged; `paragraphs` the notes as one
// paragraph; anything else `{}`.
//
// Environment:
//   FAKE_LLM_MODE      ok (default) | crash (exits during a run) | stall (says nothing after a run)
//                      | garbage (a line that is not an event) | overflow (a line over 4 MB)
//                      | ignore-cancel (never answers cancel) | load-error | context | memory
//                      | cutoff (the first answer is cut off at its room; later ones are whole)
//   FAKE_LLM_STEP_MS   milliseconds between two events of a run (default 0)
//   FAKE_LLM_LOAD_MS   milliseconds a load takes (default 0)
//   FAKE_LLM_TOKENS    output tokens an answer reports (default 48, at most maxTokens)
//   FAKE_LLM_LOG       a file each start and each line appends to (one JSON line)
'use strict'
const fs = require('node:fs')

const env = process.env
const mode = env.FAKE_LLM_MODE || 'ok'
const stepMs = Number(env.FAKE_LLM_STEP_MS) || 0
const loadMs = Number(env.FAKE_LLM_LOAD_MS) || 0
const log = (o) => {
  if (env.FAKE_LLM_LOG) fs.appendFileSync(env.FAKE_LLM_LOG, JSON.stringify(o) + '\n')
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const wait = (ms) => new Promise((r) => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)))

log({ start: true, args: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(env).filter((k) => !k.startsWith('FAKE_LLM_') && k !== 'ELECTRON_RUN_AS_NODE').sort(), pid: process.pid })

let loaded = null
let current = null
const cancelled = new Set()
let runs = 0

/** The data block of the user part: the JSON after its first line. */
function dataOf(parts) {
  const user = parts.filter((p) => !p.special).map((p) => p.t)[1] ?? ''
  const at = user.indexOf('\n')
  try {
    return JSON.parse(at >= 0 ? user.slice(at + 1) : user)
  } catch {
    return null
  }
}

function answerFor(run) {
  if (env.FAKE_LLM_ANSWER) return env.FAKE_LLM_ANSWER
  // The root rule names the answer's object rule, whose first member is the key.
  const top = (/^root ::= (\S+)$/m.exec(run.grammar) || [])[1]
  const rule = top ? run.grammar.split('\n').find((l) => l.startsWith(`${top} ::= `)) : undefined
  const key = (/^\S+ ::= "\{" ws "\\"([A-Za-z]+)\\""/.exec(rule || '') || [])[1]
  const data = dataOf(run.parts)
  switch (key) {
    case 'text':
      return JSON.stringify({ text: 'A draft written on this PC.' })
    case 'names':
      return JSON.stringify({ names: (data && Array.isArray(data.items) ? data.items : [{ id: 'a' }]).map((i) => ({ id: String(i.id), name: `Name ${i.id}` })) })
    case 'segments':
      return JSON.stringify({ segments: (data && Array.isArray(data.segments) ? data.segments : []).map((s) => ({ id: String(s.id), text: String(s.text) })) })
    case 'paragraphs':
      return JSON.stringify({ paragraphs: ['A script written on this PC.'] })
    default:
      return '{}'
  }
}

async function run(r) {
  current = r.id
  runs++
  if (mode === 'context') return out({ ev: 'error', id: r.id, code: 'context', message: 'The prompt does not fit.' })
  if (mode === 'memory') return out({ ev: 'error', id: r.id, code: 'memory', message: 'Not enough memory.' })
  if (mode === 'stall') return
  const total = Math.max(1, Math.ceil(r.parts.reduce((n, p) => n + p.t.length, 0) / 4))
  for (let done = 0; done < total; ) {
    await wait(stepMs)
    if (cancelled.has(r.id)) return mode === 'ignore-cancel' ? undefined : out({ ev: 'cancelled', id: r.id })
    done = Math.min(total, done + 64)
    out({ ev: 'read', id: r.id, done, total })
    if (mode === 'crash') process.exit(3)
    if (mode === 'garbage') return process.stdout.write('this is not an event\n')
    if (mode === 'overflow') return process.stdout.write('x'.repeat((4 << 20) + 10))
  }
  const tokens = Math.min(r.maxTokens, Number(env.FAKE_LLM_TOKENS) || 48)
  for (let t = 16; t <= tokens; t += 16) {
    await wait(stepMs)
    if (cancelled.has(r.id)) return mode === 'ignore-cancel' ? undefined : out({ ev: 'cancelled', id: r.id })
    out({ ev: 'write', id: r.id, tokens: t })
  }
  await wait(stepMs)
  if (cancelled.has(r.id)) return mode === 'ignore-cancel' ? undefined : out({ ev: 'cancelled', id: r.id })
  const whole = answerFor(r)
  const cut = mode === 'cutoff' && runs === 1
  out({ ev: 'done', id: r.id, text: cut ? whole.slice(0, Math.max(1, whole.length - 3)) : whole, prompt: total, output: cut ? r.maxTokens : tokens, readMs: 400, writeMs: 2000 })
  current = null
}

let buffer = ''
let queue = Promise.resolve()
process.stdin.on('data', (d) => {
  buffer += d.toString('utf8')
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    if (!line.trim()) continue
    let cmd
    try {
      cmd = JSON.parse(line)
    } catch {
      out({ ev: 'error', code: 'internal', message: 'the line is not JSON' })
      continue
    }
    log({ line: cmd.op === 'run' ? { op: 'run', id: cmd.id, maxTokens: cmd.maxTokens, parts: cmd.parts.length } : cmd })
    if (cmd.op === 'cancel') {
      cancelled.add(cmd.id)
      continue
    }
    queue = queue.then(async () => {
      if (cmd.op === 'load') {
        await wait(loadMs)
        if (mode === 'load-error') return out({ ev: 'error', code: 'model', message: 'The model could not be loaded.' })
        loaded = cmd.model
        return out({ ev: 'loaded', ms: loadMs, ctxTrain: 8192 })
      }
      if (cmd.op === 'run') {
        if (!loaded) return out({ ev: 'error', id: cmd.id, code: 'model', message: 'No model is loaded.' })
        return run(cmd)
      }
      out({ ev: 'error', code: 'internal', message: 'unknown `op`' })
    })
  }
})
// The end of stdin ends it at once, even in the middle of a request (as the real helper).
process.stdin.on('end', () => process.exit(0))
void current
