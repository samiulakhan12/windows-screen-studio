#!/usr/bin/env node
// Downloads the speech model the native and end-to-end tests transcribe with: the catalog's
// whisper-tiny (ggml-tiny-q8_0.bin, 43.5 MB) from its pinned Hugging Face address into
// .cache/test-speech/ (SSW_TEST_SPEECH_CACHE overrides), resumably, and checks its SHA-256. A
// file that is already there and matches is reused. It is not committed: 43.5 MB would multiply
// the repository's size (docs/design/offline-captions.md §10.3).
//
//   npm run fetch:test-speech           # prints the model's path
//
// TEST_MODEL is a copy of the catalog's pin (src/shared/speech/catalog.ts, whisper-tiny);
// tests/packaging.test.ts checks that the two agree.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEST_MODEL = {
  id: 'whisper-tiny',
  file: 'ggml-tiny-q8_0.bin',
  bytes: 43_537_433,
  sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q8_0.bin'
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The folder the test model lives in. */
export function testSpeechDir(env = process.env) {
  return path.resolve(root, env.SSW_TEST_SPEECH_CACHE || path.join('.cache', 'test-speech'))
}

/** The path of the test model (whether or not it was fetched). */
export function testModelPath(env = process.env) {
  return path.join(testSpeechDir(env), TEST_MODEL.file)
}

async function sha256(file) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

async function fetchOnce(part) {
  const have = existsSync(part) ? statSync(part).size : 0
  const res = await fetch(TEST_MODEL.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' })
  if (res.status === 416) {
    rmSync(part, { force: true })
    throw new Error('the server refused the resume (416); starting over')
  }
  if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status} from ${TEST_MODEL.url}`)
  const append = res.status === 206 && new RegExp(`^bytes ${have}-`).test(res.headers.get('content-range') ?? '')
  const out = createWriteStream(part, { flags: append ? 'a' : 'w' })
  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
    }
  } finally {
    await new Promise((resolve) => out.end(resolve))
  }
}

export async function fetchTestModel({ log = console.log } = {}) {
  const dir = testSpeechDir()
  const file = testModelPath()
  if (existsSync(file) && statSync(file).size === TEST_MODEL.bytes && (await sha256(file)) === TEST_MODEL.sha256) {
    log(`fetch-test-speech: ${path.relative(root, file) || file} is there and matches its pin`)
    return file
  }
  mkdirSync(dir, { recursive: true })
  rmSync(file, { force: true })
  const part = `${file}.part`
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      log(`fetch-test-speech: downloading ${TEST_MODEL.file} (${(TEST_MODEL.bytes / 1e6).toFixed(1)} MB)${attempt > 1 ? `, attempt ${attempt}` : ''}`)
      await fetchOnce(part)
      const size = statSync(part).size
      if (size < TEST_MODEL.bytes) throw new Error(`the download stopped at ${size} of ${TEST_MODEL.bytes} bytes`)
      if (size !== TEST_MODEL.bytes || (await sha256(part)) !== TEST_MODEL.sha256) {
        rmSync(part, { force: true })
        throw new Error('the downloaded file is not the pinned one (size or SHA-256 differs); deleted')
      }
      renameSync(part, file)
      log(`fetch-test-speech: ${path.relative(root, file) || file} (SHA-256 ${TEST_MODEL.sha256.slice(0, 12)}…, matches the catalog pin)`)
      return file
    } catch (err) {
      lastError = err
      log(`fetch-test-speech: ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw new Error(`could not download ${TEST_MODEL.url}: ${lastError?.message}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Node's fetch reads HTTPS_PROXY only with NODE_USE_ENV_PROXY (Node 22.21 and newer).
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
    process.exit(r.status ?? 1)
  }
  fetchTestModel().then(
    (file) => console.log(file),
    (err) => {
      console.error(`fetch-test-speech: ${err.message}`)
      process.exit(1)
    }
  )
}
