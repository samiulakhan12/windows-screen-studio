#!/usr/bin/env node
// Opt-in benchmark of the Bangla model (docs/design/offline-captions.md §14), not a test: it needs
// the 539 MB model, which is never committed or fetched by the tests. It transcribes the committed
// Bangla fixture (tests/fixtures/speech/bn-fleurs-blog-18s.flac, 18.84 s, FLEURS, CC BY 4.0) with
// the speech helper and the arguments the app passes for this model (--lang bn --max-chunk 20
// --no-timestamps), then prints WER, CER, the real-time factor and the peak memory against the
// fixture's transcript.
//
//   npm run bench:bangla -- --model <ggml-bengaliai-whisper-medium-q5_0.bin> [--threads N] [--helper P] [--json]
//
// The model file must match the catalog's pin (size and SHA-256); any file name works (it is
// placed under its pinned name in a temporary folder, as the helper takes a name, never a path:
// a hard link, which needs no privilege on Windows, else a symbolic link, else a copy).
// BANGLA_PIN is a copy of the catalog's entry (src/shared/speech/catalog.ts, whisper-bn-medium);
// tests/banglaBench.test.ts checks that the two agree, and that benchArgs passes what the app does.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreBangla } from './lib/banglaScore.mjs'

export const BANGLA_PIN = {
  id: 'whisper-bn-medium',
  file: 'ggml-bengaliai-whisper-medium-q5_0.bin',
  bytes: 539_257_671,
  sha256: '2c64c7f1e2c8f2417ed1fe5b78c7238933c00a2cdc2ef33e7087a95475256605',
  url: 'https://huggingface.co/winshades/bengaliai-whisper-medium-ggml/resolve/11cf5cbd282e0e46a761093939952f74906ddce1/ggml-bengaliai-whisper-medium-q5_0.bin',
  language: 'bn',
  maxChunkSeconds: 20,
  noTimestamps: true
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE = path.join(root, 'tests', 'fixtures', 'speech', 'bn-fleurs-blog-18s.flac')
export const TRANSCRIPT = path.join(root, 'tests', 'fixtures', 'speech', 'bn-fleurs-blog-18s.txt')
const VAD_MODEL = path.join(root, 'resources', 'speech', 'ggml-silero-v6.2.0.bin')
const HELPER = path.join(root, 'native', 'bin', process.platform === 'win32' ? 'ssw-speech.exe' : 'ssw-speech')

/** The helper's `transcribe` arguments, as src/main/speech/localClient.ts builds them for the Bangla model (no --stdin-control: nothing cancels here). */
export function benchArgs({ modelDir, audio, vadModel = VAD_MODEL, threads }) {
  return ['transcribe', '--model-dir', modelDir, '--model', BANGLA_PIN.file, '--audio', audio, '--vad-model', vadModel, '--lang', BANGLA_PIN.language, '--max-chunk', String(BANGLA_PIN.maxChunkSeconds), '--no-timestamps', '--threads', String(threads)]
}

/** A failure to report: thrown, so the temporary folder (which may hold a 539 MB copy) is removed first. */
class BenchError extends Error {}

function fail(message) {
  throw new BenchError(message)
}

/**
 * Puts `model` in `dir` under its pinned name and says how: a hard link (no privilege needed, the
 * same volume only), else a symbolic link (on Windows only with administrator rights or Developer
 * Mode), else a copy. `ops` replaces the file system calls (tests).
 */
export function placeModel(model, dir, ops = { linkSync, symlinkSync, copyFileSync }) {
  const dest = path.join(dir, BANGLA_PIN.file)
  const errors = []
  for (const [how, op] of [
    ['hard link', ops.linkSync],
    ['symbolic link', ops.symlinkSync],
    ['copy', ops.copyFileSync]
  ]) {
    try {
      op(model, dest)
      return how
    } catch (err) {
      errors.push(`${how}: ${err?.code ?? err?.message ?? err}`)
    }
  }
  throw new BenchError(`could not put the model in ${dir} (${errors.join('; ')}). Free some disk space, or pass --model a file on the same drive as ${os.tmpdir()}.`)
}

function options(argv) {
  const out = { model: null, threads: Math.min(4, Math.max(1, os.cpus().length)), helper: HELPER, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model') out.model = argv[++i]
    else if (a === '--threads') out.threads = Number(argv[++i])
    else if (a === '--helper') out.helper = argv[++i]
    else if (a === '--json') out.json = true
    else fail(`unknown argument ${a}`)
  }
  if (!out.model) fail(`--model <file> is required: the Bangla model (${BANGLA_PIN.file}, ${BANGLA_PIN.bytes} bytes) from ${BANGLA_PIN.url}`)
  if (!Number.isInteger(out.threads) || out.threads < 1 || out.threads > 64) fail('--threads must be 1..64')
  return out
}

async function sha256(file) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

async function main() {
  const o = options(process.argv.slice(2))
  const model = path.resolve(o.model)
  if (!existsSync(model) || !statSync(model).isFile()) fail(`no model file at ${model}`)
  if (statSync(model).size !== BANGLA_PIN.bytes) fail(`${model} is ${statSync(model).size} bytes, the pin is ${BANGLA_PIN.bytes}`)
  if ((await sha256(model)) !== BANGLA_PIN.sha256) fail(`${model} does not match the pinned SHA-256 ${BANGLA_PIN.sha256}`)
  if (!existsSync(o.helper)) fail(`the speech helper is missing at ${o.helper}: run npm run build:speech-host`)
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
  if (!ffmpeg || !existsSync(ffmpeg)) fail('ffmpeg-static is missing: run npm ci')

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ssw-bench-bangla-'))
  try {
    placeModel(model, tmp)
    const wav = path.join(tmp, 'bn.wav')
    const dec = spawnSync(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', FIXTURE, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wav], { encoding: 'utf8' })
    if (dec.status !== 0) fail(`ffmpeg could not decode the fixture: ${dec.stderr}`)
    const started = Date.now()
    const run = spawnSync(o.helper, benchArgs({ modelDir: tmp, audio: wav, threads: o.threads }), { cwd: tmp, encoding: 'utf8', maxBuffer: 64 << 20 })
    const wallMs = Date.now() - started
    const lines = run.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const error = lines.find((l) => l.type === 'error')
    const result = lines.find((l) => l.type === 'result')
    if (run.status !== 0 || error || !result) fail(`the helper failed (exit ${run.status}): ${error ? `${error.code}: ${error.message}` : run.stderr.trim().split('\n').slice(-3).join(' | ')}`)
    // As the app builds a caption's text: its words, NFC (localTranscript does the same for Bengali).
    const segments = lines.filter((l) => l.type === 'segment')
    const hypothesis = segments
      .map((s) => (s.words?.length ? s.words.map((w) => w.text.trim()).join(' ') : s.text))
      .join(' ')
      .normalize('NFC')
    const score = scoreBangla(readFileSync(TRANSCRIPT, 'utf8'), hypothesis)
    const report = {
      model: BANGLA_PIN.file,
      fixture: path.relative(root, FIXTURE),
      audioSeconds: result.duration,
      threads: o.threads,
      arguments: `--lang ${BANGLA_PIN.language} --max-chunk ${BANGLA_PIN.maxChunkSeconds} --no-timestamps`,
      language: result.language,
      wer: Math.round(score.wer * 1000) / 10,
      cer: Math.round(score.cer * 1000) / 10,
      words: score.words,
      wordEdits: score.wordEdits,
      rtf: Math.round((result.timing.asr_ms / 1000 / result.duration) * 1000) / 1000,
      wallSeconds: Math.round(wallMs / 100) / 10,
      loadMs: result.timing.load_ms,
      peakRssMb: result.timing.peak_rss_mb,
      reference: score.reference,
      hypothesis: score.hypothesis
    }
    if (o.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`Bangla model benchmark: ${report.model} on ${report.fixture} (${report.audioSeconds} s), ${report.threads} threads, ${report.arguments}`)
      console.log(`  WER ${report.wer} % (${report.wordEdits} edits in ${report.words} words), CER ${report.cer} %`)
      console.log(`  RTF ${report.rtf} (transcription only), ${report.wallSeconds} s in all, model load ${report.loadMs} ms, peak memory ${report.peakRssMb} MB`)
      console.log(`  reference:  ${report.reference}`)
      console.log(`  hypothesis: ${report.hypothesis}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((err) => {
    console.error(`bench-bangla: ${err instanceof BenchError ? err.message : (err?.stack ?? err)}`)
    process.exit(1)
  })
}
