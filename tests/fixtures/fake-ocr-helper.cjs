#!/usr/bin/env node
'use strict'
/*
 * A scripted stand-in for ssw-ocr.exe (docs/design/auto-blur.md §16.2) for main's tests and the
 * end-to-end runs: it speaks the helper's protocol (src/shared/privacy/protocol.ts) on stdin and
 * stdout and answers from a JSON script named by SSW_OCR_SCRIPT (a file). Every command it
 * receives is appended to SSW_OCR_LOG (a file), with one { start } line per process.
 *
 * Script (every key optional):
 *   protocol        the protocol number `opened` answers (1)
 *   open            'ok' (default) or 'model' (a pin that does not match: error 'model')
 *   openMs          how long `open` takes; heartbeats go on meanwhile
 *   heartbeatMs     the heartbeat (2000); 0: none
 *   silentAfterOpen stop writing anything, heartbeats included, once opened
 *   marker          written to stderr at start, and inside a malformed stdout line
 *   hugeLine        write a line over 16 MB after opening
 *   badLines        lines written to stdout after opening (malformed on purpose)
 *   reads           { "<n>": rule } for the n-th read received (1-based); `read` is the rule otherwise.
 *                   A rule: { lines (texts, or whole lines), qr, partial, error, crash: <exit code>, stall: true, delayMs }
 *   crashStart      a process number (1-based, counted in SSW_OCR_LOG) from which every read crashes
 *   holdReads       answer reads only once this many have arrived, newest first
 *   look            frames answered to `look`, in two batches
 *   matched         { parts, second } of every track a `match` answers
 */
const fs = require('node:fs')
const readline = require('node:readline')

const script = (() => {
  try {
    return JSON.parse(fs.readFileSync(process.env.SSW_OCR_SCRIPT || '', 'utf8'))
  } catch {
    return {}
  }
})()
const logFile = process.env.SSW_OCR_LOG
const log = (o) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`)
}
const processNo = (() => {
  if (!logFile) return 1
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('"start":true')).length + 1
  } catch {
    return 1
  }
})()
log({ start: true, args: process.argv.slice(2), pid: process.pid, n: processNo })

let silent = false
const send = (o) => {
  if (silent) return
  process.stdout.write(`${JSON.stringify(o)}\n`)
}

if (script.marker) process.stderr.write(`fake helper says ${script.marker}\n`)
let beats = 0
const heartbeatMs = script.heartbeatMs === undefined ? 2000 : script.heartbeatMs
send({ alive: beats++ })
if (heartbeatMs > 0) setInterval(() => send({ alive: beats++ }), heartbeatMs).unref()

const line = (text, conf = 0.95) => {
  const spans = [...text].map((_c, i) => [10 + i * 8, 18 + i * 8])
  return { box: [10, 10, 8 * text.length + 8, 20], quad: [[10, 10], [18 + 8 * text.length, 10], [18 + 8 * text.length, 30], [10, 30]], variants: [{ model: 'tiny', text, conf, spans }], ring: '#ffffff', spread: 0 }
}

let reads = 0
const held = []
const stalled = new Set()

function answerRead(cmd) {
  reads++
  const rule = (script.reads && script.reads[String(reads)]) || script.read || {}
  if ((script.crashStart && processNo >= script.crashStart) || rule.crash !== undefined) {
    if (script.marker) process.stderr.write(`dying on a line holding ${script.marker}\n`)
    process.exit(rule.crash === undefined ? 3 : rule.crash)
  }
  if (rule.stall) {
    stalled.add(cmd.id)
    return
  }
  const answer = rule.error
    ? { id: cmd.id, error: rule.error }
    : { id: cmd.id, read: { t: cmd.t, lines: (rule.lines || ['hello']).map((t) => (typeof t === 'string' ? line(t) : t)), qr: rule.qr || [], ...(rule.partial ? { partial: rule.partial } : {}) } }
  const go = () => {
    if (script.holdReads) {
      held.push(answer)
      if (held.length >= script.holdReads) for (const a of held.splice(0).reverse()) send(a)
      return
    }
    send(answer)
  }
  if (rule.delayMs) setTimeout(go, rule.delayMs)
  else go()
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (text) => {
  let cmd
  try {
    cmd = JSON.parse(text)
  } catch {
    send({ id: 0, error: 'bad-command' })
    return
  }
  log({ line: cmd })
  switch (cmd.op) {
    case 'open':
      setTimeout(() => {
        if (script.open === 'model') return send({ id: cmd.id, error: 'model' })
        send({ id: cmd.id, opened: { protocol: script.protocol === undefined ? 1 : script.protocol, version: 'fake', reader: cmd.reader } })
        if (script.marker) process.stdout.write(`{"id": oops ${script.marker}\n`)
        for (const l of script.badLines || []) process.stdout.write(`${l}\n`)
        if (script.hugeLine) process.stdout.write(`{"id":1,"x":"${'x'.repeat(16 * 1024 * 1024 + 10)}"}\n`)
        if (script.silentAfterOpen) silent = true
      }, script.openMs || 0)
      return
    case 'look': {
      const frames = script.look || []
      const half = Math.ceil(frames.length / 2)
      send({ id: cmd.id, look: frames.slice(0, half), done: false })
      send({ id: cmd.id, look: frames.slice(half), done: true })
      return
    }
    case 'read':
      return answerRead(cmd)
    case 'careful':
      return send({ id: cmd.id, careful: cmd.lines.map((i) => [{ model: 'small', text: `careful ${i}`, conf: 0.99, spans: [] }]) })
    case 'release':
    case 'pause':
    case 'resume':
      return
    case 'followOpen':
      return send({ id: cmd.id, session: { from: cmd.from, to: cmd.to, frames: 0 } })
    case 'track':
    case 'closeSession':
      return send({ id: cmd.id, done: true })
    case 'match': {
      const m = script.matched || {}
      return send({ id: cmd.id, matched: cmd.tracks.map((t) => ({ track: t.track, parts: t.parts.map(() => (m.parts === undefined ? 0.9 : m.parts)), best: t.candidates[0] || null, second: m.second === undefined ? 0.1 : m.second })) })
    }
    case 'cancel':
      if (stalled.delete(cmd.target)) send({ id: cmd.target, error: 'cancelled' })
      return
    case 'stop':
      send({ id: cmd.id, done: true })
      return process.exit(0)
    default:
      return send({ id: cmd.id, error: 'bad-command' })
  }
})
rl.on('close', () => process.exit(0))
