/**
 * Real speech for the offline captions and speech detector tests (docs/design/offline-captions.md
 * §10.3), built with ffmpeg from the committed FLACs in tests/fixtures/speech and cached between
 * runs:
 *
 *   0-1 s silence, 1.0-12.0 s JFK, 12.0-16.0 s brown noise at about -45 dBFS with 5 ms key
 *   clicks at 8 Hz, 16.0-21.86 s LibriSpeech 1272-128104-0000, silence to 23.86 s.
 *
 * A project is seeded with that sound as mic.m4a, a silent system.m4a (audioStems { mic, system })
 * and a mixed track of the same sound in screen.mp4. Also: the paths of the speech helper and the
 * test model, and checks that fail (never skip) when they are missing.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const h = require('./helpers.cjs')
const { MEDIA_CACHE } = require('./render-fixtures.cjs')

const SPEECH = path.join(h.APP_DIR, 'tests/fixtures/speech')
const JFK = path.join(SPEECH, 'jfk-16k.flac')
const LS = path.join(SPEECH, 'ls-1272-128104-0000.flac')
/** Seconds of the fixture sound. */
const SECONDS = 23.86
/** Where the parts are, source seconds. */
const PARTS = { jfk: [1.0, 12.0], noise: [12.0, 16.0], ls: [16.0, 21.86] }

/** The host build of the speech helper (npm run build:speech-host) and the test model (npm run fetch:test-speech). */
const HELPER = path.join(h.APP_DIR, 'native/bin', process.platform === 'win32' ? 'ssw-speech.exe' : 'ssw-speech')
const TEST_MODEL_DIR = process.env.SSW_TEST_SPEECH_CACHE || path.join(h.APP_DIR, '.cache/test-speech')
const TEST_MODEL = { id: 'whisper-tiny', file: 'ggml-tiny-q8_0.bin', bytes: 43_537_433, sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca' }
/** The wrapper that holds part 1 of a transcription until cancelled (tests/e2e/speech-hold-helper.sh). */
const HOLD_HELPER = path.join(__dirname, 'speech-hold-helper.sh')

/** Fails (never skips) when the helper or the test model is missing, with the commands that make them. */
function requireSpeechAssets({ model = true } = {}) {
  h.assert(fs.existsSync(HELPER), `the speech helper is missing at ${HELPER}: run npm run build:speech-host`)
  if (model) h.assert(fs.existsSync(path.join(TEST_MODEL_DIR, TEST_MODEL.file)), `the test model is missing in ${TEST_MODEL_DIR}: run npm run fetch:test-speech`)
}

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] })

/** The fixture sound as 48 kHz mono WAV (cached). */
function speechWav() {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true })
  const file = path.join(MEDIA_CACHE, 'speech-fixture-v1.wav')
  if (fs.existsSync(file)) return file
  const tmp = `${file}.part.wav`
  // Brown noise at about -45 dBFS RMS with 5 ms clicks (a 3 kHz blip at -12 dBFS) 8 times a second.
  const noise = "anoisesrc=color=brown:amplitude=0.02:sample_rate=48000:seed=7:d=4,volume=-12dB"
  const clicks = "aevalsrc='if(lt(mod(t\\,0.125)\\,0.005)\\,0.25*sin(2*PI*3000*t)\\,0)':s=48000:d=4"
  const graph = [
    'anullsrc=r=48000:cl=mono,atrim=0:1[s0]',
    `[0:a]aresample=48000,aformat=channel_layouts=mono[jfk]`,
    `${noise}[n]`,
    `${clicks}[c]`,
    '[n][c]amix=inputs=2:normalize=0[nc]',
    `[1:a]aresample=48000,aformat=channel_layouts=mono[ls]`,
    'anullsrc=r=48000:cl=mono,atrim=0:2[s1]',
    '[s0][jfk][nc][ls][s1]concat=n=5:v=0:a=1,atrim=0:' + SECONDS + '[out]'
  ].join(';')
  ff(['-i', JFK, '-i', LS, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s16le', tmp])
  fs.renameSync(tmp, file)
  return file
}

/** The fixture media: mic.m4a, a silent system.m4a and screen.mp4 with the same sound mixed in (cached). */
function speechMedia() {
  const wav = speechWav()
  const dir = path.join(MEDIA_CACHE, 'speech-fixture-v1')
  const out = { mic: path.join(dir, 'mic.m4a'), system: path.join(dir, 'system.m4a'), screen: path.join(dir, 'screen.mp4') }
  if (Object.values(out).every((f) => fs.existsSync(f))) return out
  fs.mkdirSync(dir, { recursive: true })
  ff(['-i', wav, '-c:a', 'aac', '-b:a', '128k', `${out.mic}.part.m4a`])
  ff(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', String(SECONDS), '-c:a', 'aac', '-b:a', '64k', `${out.system}.part.m4a`])
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-i', wav,
    '-t', String(SECONDS),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    `${out.screen}.part.mp4`
  ])
  for (const [k, f] of Object.entries(out)) fs.renameSync(`${f}.part${path.extname(f)}`, out[k])
  return out
}

/**
 * Seeds the speech project into `home`: with `stems` (default) mic.m4a and a silent system.m4a
 * beside a mixed screen.mp4, else the mixed track only. `extra` is merged into project.json.
 */
function seedSpeechProject(home, { id = 'rec-speech', name = 'Speech', stems = true, extra = {}, cursor } = {}) {
  const media = speechMedia()
  const dir = path.join(h.projectsRoot(home), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(media.screen, path.join(dir, 'screen.mp4'))
  if (stems) {
    fs.symlinkSync(media.mic, path.join(dir, 'mic.m4a'))
    fs.symlinkSync(media.system, path.join(dir, 'system.m4a'))
  }
  const project = {
    version: 2,
    id,
    name,
    createdAt: new Date().toISOString(),
    duration: SECONDS,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    ...(stems ? { audioStems: { mic: true, system: true } } : {}),
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [{ id: 'c0', start: 0, end: SECONDS, speed: 1 }],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...extra
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  fs.writeFileSync(path.join(dir, 'cursor.json'), JSON.stringify(cursor || { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }))
  return id
}

/** Lowercased words without punctuation. */
const plainWords = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

module.exports = { SECONDS, PARTS, HELPER, HOLD_HELPER, TEST_MODEL, TEST_MODEL_DIR, requireSpeechAssets, speechWav, speechMedia, seedSpeechProject, plainWords, JFK, LS }
