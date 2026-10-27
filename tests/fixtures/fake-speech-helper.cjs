#!/usr/bin/env node
// Stand-in for native/bin/ssw-speech that speaks the protocol of src/shared/speech/protocol.ts
// (docs/design/offline-captions.md §5.2). Used through SSW_SPEECH_HELPER by the main process
// tests (speechHelper, localClient, audioAnalysisSpeech) and handy for trying the app's local
// path without the native build.
//
// Subcommands: cpu | vad | transcribe, with the real helper's arguments.
// Environment (the helper's environment is minimal; only FAKE_SPEECH_* reach a script override):
//   FAKE_SPEECH_CPU        JSON merged into the cpu line (default: everything true, 4 logical)
//   FAKE_SPEECH_MODE       ok (default) | crash | illegal | stall | hang | memory | model | language
//                          | cpu-error | internal | garbage | overflow | no-result | slow-cancel | silent
//                          | old (Flown 0.4.0's helper: refuses --no-timestamps as an unknown argument)
//                          A mode can be limited to calls whose arguments contain FAKE_SPEECH_MATCH, and
//                          to the first FAKE_SPEECH_TIMES calls (counted in FAKE_SPEECH_COUNTER, a file).
//   FAKE_SPEECH_LANG       the language a transcription detects (default en)
//   FAKE_SPEECH_LANG_S     language_s it reports under --lang auto (default 12)
//   FAKE_SPEECH_LOG        a file each call appends its arguments to (one JSON line)
//   FAKE_SPEECH_SPEECH     JSON [[start, end], …] seconds of speech `vad` reports (default [[1, 3]])
//   FAKE_SPEECH_AUDIO_S    audio_s `vad` reports (default: the samples it read)
//   FAKE_SPEECH_PART_SPEECH JSON [[start, end], …] the speech line of `transcribe` reports (default: the whole part)
'use strict'
const fs = require('node:fs')

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const env = process.env
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
if (env.FAKE_SPEECH_LOG) fs.appendFileSync(env.FAKE_SPEECH_LOG, JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(env).sort() }) + '\n')

function modeNow() {
  const mode = env.FAKE_SPEECH_MODE || 'ok'
  if (env.FAKE_SPEECH_MATCH && !args.some((a) => a.includes(env.FAKE_SPEECH_MATCH))) return 'ok'
  if (env.FAKE_SPEECH_TIMES && env.FAKE_SPEECH_COUNTER) {
    let n = 0
    try {
      n = Number(fs.readFileSync(env.FAKE_SPEECH_COUNTER, 'utf8')) || 0
    } catch {}
    fs.writeFileSync(env.FAKE_SPEECH_COUNTER, String(n + 1))
    if (n >= Number(env.FAKE_SPEECH_TIMES)) return 'ok'
  }
  return mode
}
const mode = modeNow()

function common() {
  if (mode === 'crash') process.kill(process.pid, 'SIGSEGV')
  if (mode === 'illegal') process.kill(process.pid, 'SIGILL')
  if (mode === 'garbage') {
    process.stdout.write('this is not json\n{"type":"progress","percent":"x"}\n')
    process.exit(0)
  }
  if (mode === 'overflow') {
    process.stdout.write('x'.repeat((1 << 20) + 10))
    setInterval(() => {}, 1000)
    return true
  }
  if (mode === 'old' && args.includes('--no-timestamps')) {
    out({ type: 'error', code: 'args', message: 'unknown argument --no-timestamps' })
    process.exit(1)
  }
  for (const [m, code] of [['memory', 'memory'], ['model', 'model'], ['language', 'language'], ['cpu-error', 'cpu'], ['internal', 'internal']]) {
    if (mode === m) {
      out({ type: 'error', code, message: `fake ${code} error` })
      process.exit(1)
    }
  }
  return false
}

/** WAV data seconds (16 kHz mono s16 after a 44-byte header). */
function wavSeconds(file) {
  try {
    return Math.max(0, fs.statSync(file).size - 44) / 32000
  } catch {
    return 0
  }
}

if (cmd === 'cpu') {
  if (common()) return
  out({ type: 'cpu', sse42: true, avx: true, avx2: true, fma: true, f16c: true, bmi2: true, logical: 4, ...JSON.parse(env.FAKE_SPEECH_CPU || '{}') })
  process.exit(0)
} else if (cmd === 'vad') {
  if (common()) return
  let bytes = 0
  process.stdin.on('data', (d) => (bytes += d.length))
  process.stdin.on('end', () => {
    if (mode === 'stall' || mode === 'hang') return setInterval(() => {}, 1000)
    const audio = env.FAKE_SPEECH_AUDIO_S ? Number(env.FAKE_SPEECH_AUDIO_S) : bytes / 4 / 16000
    const n = Math.floor(audio / 0.032)
    const probs = Buffer.alloc(n)
    for (const [s, e] of JSON.parse(env.FAKE_SPEECH_SPEECH || '[[1,3]]')) for (let i = Math.floor(s / 0.032); i < Math.min(n, Math.ceil(e / 0.032)); i++) probs[i] = 240
    out({ type: 'vad', audio_s: +audio.toFixed(3), frame: 0.032, n, probs: probs.toString('base64'), detect_ms: 5 })
    process.exit(0)
  })
} else if (cmd === 'transcribe') {
  if (common()) return
  const audio = opt('--audio')
  const lang = opt('--lang') || 'auto'
  const seconds = wavSeconds(audio)
  let cancelled = false
  const finishCancelled = () => {
    out({ type: 'cancelled', done_until: 0 })
    process.exit(2)
  }
  process.stdin.setEncoding('utf8')
  let input = ''
  process.stdin.on('data', (d) => {
    input += d
    if (/^cancel$/m.test(input)) {
      cancelled = true
      if (mode !== 'slow-cancel') finishCancelled()
    }
  })
  process.stdin.on('end', () => {
    cancelled = true
    if (mode !== 'slow-cancel') finishCancelled()
  })
  if (mode === 'silent') return setInterval(() => {}, 1000)
  out({ type: 'ready', model: 'tiny', multilingual: true, dtw: 'TINY', build: 'host', system: 'fake' })
  if (mode === 'stall' || mode === 'hang' || mode === 'slow-cancel') {
    out({ type: 'progress', percent: 0, at: 0 })
    // stall: no more lines; hang: a heartbeat but never done.
    if (mode === 'hang') setInterval(() => out({ type: 'progress', percent: 1, at: 0 }), 50)
    else setInterval(() => {}, 1000)
    return
  }
  out({ type: 'speech', segments: env.FAKE_SPEECH_PART_SPEECH ? JSON.parse(env.FAKE_SPEECH_PART_SPEECH) : [[0, Math.max(0, seconds)]] })
  // One word per second: "w<second>" from the part's start.
  const words = []
  for (let t = 0; t + 0.5 <= seconds; t += 1) words.push({ text: `w${Math.round(t)}`, start: +t.toFixed(3), end: +(t + 0.4).toFixed(3), prob: 0.9 })
  const half = Math.ceil(words.length / 2)
  const segs = [words.slice(0, half), words.slice(half)].filter((w) => w.length)
  let i = 0
  const next = () => {
    if (cancelled) return
    if (i < segs.length) {
      const w = segs[i++]
      out({ type: 'progress', percent: Math.round((i / segs.length) * 100), at: w[w.length - 1].end })
      out({ type: 'segment', start: w[0].start, end: w[w.length - 1].end, text: w.map((x) => x.text).join(' '), words: w })
      return setTimeout(next, 5)
    }
    if (mode !== 'no-result') {
      const language = lang === 'auto' ? (words.length ? env.FAKE_SPEECH_LANG || 'en' : '') : lang
      out({ type: 'result', language, language_s: lang === 'auto' && words.length ? Number(env.FAKE_SPEECH_LANG_S ?? 12) : 0, duration: seconds, timing: { load_ms: 1, vad_ms: 1, asr_ms: 1, rtf: 0.01, peak_rss_mb: 50 } })
    }
    process.exit(0)
  }
  next()
} else {
  out({ type: 'error', code: 'args', message: `unknown subcommand ${cmd}` })
  process.exit(1)
}
