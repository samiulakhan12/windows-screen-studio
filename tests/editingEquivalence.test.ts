import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import type { CaptionSegment, CursorTrack, Graphic, Project } from '../src/shared/types'
import { digest, rng, sceneFixtures, seededTrack } from './verticalFixtures'

/*
 * The equivalence guard of editing polish (docs/design/editing-polish.md §19.2): what drawFrame
 * draws for old projects at 24 sampled export frames (cuts, freezes, zooms, spotlights, shapes,
 * texts, title cards and graphics included), and the sound of their export job (the parts the
 * exporter hands to the main process and the ffmpeg graph main builds from them), pinned against
 * the code before the contracts step (22eec31: everything through wave 8, versions, the filmstrip,
 * frame nudge and Captions Studio phase B). Wave 10 only adds optional fields, and every new
 * drawing and sound step returns at once without its field, so every value here must stay the
 * same bit for bit after the contracts and after every part. Values are digests of their exact
 * JSON (tests/verticalFixtures.ts digest); a changed digest names the fixture and the part. The
 * snapshots are never regenerated to make a change pass.
 *
 * Decision 2 of §0 (users' own looping Opus and M4A music read from a decoded copy) changes only
 * the music input's file name: the case 'looped opus music' pins the graph with the file main
 * reads given separately, so only that name may differ.
 */

/* ---------- canvases that record their calls (as tests/captionsStudioEquivalence.test.ts) ---------- */

interface Call {
  canvas: number
  name: string
  args: unknown[]
  font: unknown
  fill: unknown
  stroke: unknown
  alpha: unknown
  quality: unknown
  composite: unknown
  dash: unknown
}
const calls: Call[] = []
let canvases = 0

/** A canvas whose 2D context records its calls with the state they draw with. */
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText')
        return (text: string) => ({
          width: String(text).length * 9,
          actualBoundingBoxAscent: 7,
          actualBoundingBoxDescent: 2
        })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      if (prop === 'getLineDash') return () => []
      return (...args: unknown[]) =>
        void calls.push({
          canvas: id,
          name: String(prop),
          args,
          font: target.font,
          fill: target.fillStyle,
          stroke: target.strokeStyle,
          alpha: target.globalAlpha,
          quality: target.imageSmoothingQuality,
          composite: target.globalCompositeOperation,
          dash: target.lineDashOffset
        })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  c.toBlob = (cb: (b: null) => void) => cb(null)
  return c
}

vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

/* ---------- the exporter, caught where it hands its job to the main process (as tests/bleepExportJob.test.ts) ---------- */

const jobs: ExportJob[] = []
// Image assets, the recording's measured sound and the music's length come from files: fixed here.
vi.mock('../src/renderer/src/render/cursorLayer', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  prepareCursorAssets: async () => undefined
}))
vi.mock('../src/renderer/src/render/watermarkLayer', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  prepareStyleAssets: async () => undefined
}))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({
  loadAudioAnalysis: async () => ({})
}))
vi.mock('../src/renderer/src/editor/media', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  mediaDuration: async () => 61.5
}))
vi.stubGlobal('window', {
  api: {
    exportCapabilities: async () => ({
      hardwareEncoders: [],
      gpuCanvas: false,
      overrides: { videoEncoder: 'ffmpeg' }
    }),
    exportStart: async (_id: string, job: ExportJob) => void jobs.push(job),
    exportCancel: async () => undefined,
    exportFinish: async () => ({ bytes: 1 })
  }
})

const { migrateProject, createProject } = await import('../src/shared/engine/project')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { outputSize } = await import('../src/shared/engine/layout')
const { planOf, videoFrames } = await import('../src/shared/engine/freeze')
const { planSoundtrack } = await import('../src/shared/render/audioPlan')
const { studioPreset } = await import('../src/shared/captions/studioPresets')

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
type DrawFrame = (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: { blurSamples?: number; frameInterval?: number }, soundTime?: number) => void
const COMPOSITOR = '../src/renderer/src/render/compositor'
const EXPORTER = '../src/renderer/src/editor/exporter'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: DrawFrame
}
const { exportVideo } = (await import(/* @vite-ignore */ EXPORTER)) as {
  exportVideo(input: unknown): Promise<unknown>
}

/** The digests of today's outputs (22eec31), by fixture: the 24 frames' call logs, and the export job's sound. */
const SNAPSHOT: Record<string, { frames: string; sound: string }> = {
  'old 16:9': {
    frames: '6769fa6423200b9b54875dae49f6e862',
    sound: '3323070bfb977f65ce926d5e487a9972'
  },
  'old 9:16': {
    frames: 'c67160254898876ec43c7176031d38b3',
    sound: '634c6607b9df9012d3404c036d2931bd'
  },
  'old 1:1': {
    frames: '71bb2211a14aede23f33f5b91ea2d558',
    sound: 'a3353e1cefb783f1ceb03895edc37df9'
  },
  'old publish-pack': {
    frames: 'b124ac13a84880840bce061d47bce2e0',
    sound: 'b811767e547d9ca675c3b8efe2775899'
  },
  'old review-mode': {
    frames: 'b4465144b93561f37c895d3e84f569c6',
    sound: '6bc06fdbc7ae9ac51e905e72091ae079'
  },
  'old sound-finder': {
    frames: '8dfc8e2f53d643a8a087e425a85d28c7',
    sound: 'd467633851ba8665ecf03dd6930a2f20'
  },
  'old nw09-speakers': {
    frames: '457054755bb604190b92af672e747b1d',
    sound: 'b811767e547d9ca675c3b8efe2775899'
  },
  'old tall-karaoke': {
    frames: '4232ab4bc9bce59c59771caf0154ce50',
    sound: '039f445018469ff02c25bf068e8a291f'
  },
  'old default-look': {
    frames: '991b8f4a05245a0795344243e59e88ec',
    sound: '660e6901dc04c760f3d85b0f3ca54ef4'
  },
  'old minimal-hidden': {
    frames: '4ac30005cdc4318dccedfeb127fd67ca',
    sound: '605de36006f96ef84628935500805d09'
  },
  'scene wide-auto': {
    frames: '10e28a6c417bce0d390abae3751eae04',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene tall-fitted': {
    frames: '84fe8b00a376ff22758d944b6a8f1e5e',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene square-fitted': {
    frames: '6d5f27ae12d7ba5532bcc8b1b59992c9',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene wide-corners': {
    frames: '27b0754f2011eead5b9b5d1a29dac13d',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene wide-side': {
    frames: '0bea29947c0a2d2e80c13661c21c249c',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene tall-layouts': {
    frames: 'b7e5bc00171ab62253836f81a017c4a7',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene square-corners': {
    frames: 'c7d128824053776b23bbb16bdd6f4b8e',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene crop-wide': {
    frames: '3c3197abd90e7219213c610d6328348a',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene crop-tall': {
    frames: '18f51fa005128e8998f936881ccce887',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene frame-browser': {
    frames: '799f69c5addb6fdefafb17d52bdb7c7c',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene frame-laptop-tall': {
    frames: '2abd68d508dda90685580b96df606d7a',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  'scene window-43': {
    frames: '0d0e8d349a53ee1d101eeb1df63380ff',
    sound: '8dc430f324336479567c0c97da97f02d'
  },
  everything: {
    frames: '7edbd7969e367a42acc1fbc40ffc0396',
    sound: 'c043b467f4cbd96ca0d39528d89d6602'
  },
  'looped mp3 music': {
    frames: 'c4cd9a9dda2d5acfdf8e4567bd7bf34b',
    sound: '8a6b65f3bc9009c3031e0bb8746aef35'
  },
  'looped opus music': {
    frames: '64ba1f408538f1e99abe02250ea37fbf',
    sound: '2b69ceec5ffc480a61e01259254aca82'
  },
  'music played once': {
    frames: 'a3210ca2ff711c1ef313079145340368',
    sound: '1af0949cd9d59bc670057db37b2dbb65'
  }
}

/* ---------- fixtures ---------- */

interface OldFixture {
  name: string
  raw: Record<string, unknown>
}
const load = (file: string): OldFixture[] => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))

interface Case {
  name: string
  project: Project
  track: CursorTrack
}

/** A project with every kind of item wave 9 knows: cuts, a speed change, both freezes, zooms, spotlights, every shape, texts, title cards, chapters, a Captions Studio look with graphics and a bleep, and music. */
function everything(music: 'none' | 'mp3' | 'opus' | 'once'): Project {
  const p = createProject({
    id: 'w10guard',
    name: 'Everything',
    duration: 40,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0.2,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  const words = (id: string, start: number, text: string): CaptionSegment => {
    const list = text.split(' ')
    return {
      id,
      start,
      end: start + list.length * 0.4,
      text,
      words: list.map((w, i) => ({
        text: w,
        start: start + i * 0.4,
        end: start + i * 0.4 + 0.35
      }))
    }
  }
  const look = studioPreset('neon')?.look
  const graphics: Graphic[] = [
    {
      id: 'g1',
      kind: 'keyword',
      start: 3,
      end: 5.5,
      place: 'auto',
      size: 0.06,
      enter: { kind: 'pop', duration: 0.3, strength: 1 },
      exit: { kind: 'fade', duration: 0.2, strength: 1 },
      sound: 'pop',
      text: 'Save',
      look: 'card'
    },
    {
      id: 'g2',
      kind: 'emoji',
      start: 16,
      end: 18,
      place: { x: 0.7, y: 0.3 },
      size: 0.08,
      enter: { kind: 'rise', duration: 0.4, strength: 1 },
      exit: { kind: 'fade', duration: 0.2, strength: 1 },
      sound: 'ding',
      emoji: '1f525'
    },
    {
      id: 'g3',
      kind: 'counter',
      start: 22,
      end: 25,
      place: 'auto',
      size: 0.07,
      enter: { kind: 'grow', duration: 0.3, strength: 1 },
      exit: { kind: 'fade', duration: 0.2, strength: 1 },
      from: 0,
      to: 300,
      decimals: 0,
      prefix: '',
      suffix: '%',
      locale: 'en',
      countFor: 1.2
    },
    {
      id: 'g4',
      kind: 'list',
      start: 32,
      end: 36,
      place: 'auto',
      size: 0.05,
      enter: { kind: 'fade', duration: 0.3, strength: 1 },
      exit: { kind: 'fade', duration: 0.2, strength: 1 },
      sound: 'pop',
      marker: 'check',
      title: 'Steps',
      items: [
        { text: 'Open', at: 32 },
        { text: 'Export', at: 33 }
      ]
    }
  ]
  const musicFile = music === 'opus' ? 'music-2.opus' : music === 'once' ? 'music-3.m4a' : 'music-1.mp3'
  return {
    ...p,
    clips: [
      { id: 'a', start: 0.5, end: 9, speed: 1 },
      { id: 'b', start: 10.2, end: 18, speed: 1 },
      { id: 'c', start: 18, end: 26, speed: 2 },
      { id: 'd', start: 27.5, end: 40, speed: 1 }
    ],
    freezes: [
      { id: 'f1', at: 6, length: 1.5, sound: 'pause' },
      { id: 'f2', at: 30, length: 2, sound: 'continue' }
    ],
    zooms: [
      { id: 'z1', start: 2, end: 6, scale: 2, focus: { mode: 'cursor' } },
      {
        id: 'z2',
        start: 12,
        end: 15,
        scale: 1.6,
        focus: { mode: 'fixed', x: 0.3, y: 0.4 },
        transition: 0.5
      },
      {
        id: 'z3',
        start: 15,
        end: 17,
        scale: 2.2,
        focus: { mode: 'region', x: 0.5, y: 0.5, w: 0.3, h: 0.3 }
      },
      {
        id: 'z4',
        start: 33,
        end: 38,
        scale: 0.8,
        focus: { mode: 'cursor' },
        easing: 'snappy'
      }
    ],
    spotlights: [
      {
        id: 's1',
        start: 4,
        end: 7,
        mode: 'region',
        x: 0.2,
        y: 0.2,
        w: 0.3,
        h: 0.25,
        shape: 'ellipse',
        dim: 0.5,
        feather: 0.3
      },
      {
        id: 's2',
        start: 28,
        end: 31,
        mode: 'cursor',
        x: 0,
        y: 0,
        w: 0.2,
        h: 0.2,
        shape: 'rect',
        dim: 0.4,
        feather: 0
      }
    ],
    shapes: [
      {
        id: 'h1',
        start: 1,
        end: 4,
        kind: 'arrow',
        x: 0.1,
        y: 0.1,
        w: 0.3,
        h: 0.2,
        color: '#ff3b30',
        strokeWidth: 6,
        fill: false,
        opacity: 1,
        strength: 0.5
      },
      {
        id: 'h2',
        start: 11,
        end: 14,
        kind: 'line',
        x: 0.5,
        y: 0.6,
        w: -0.2,
        h: 0.1,
        color: '#ffd60a',
        strokeWidth: 4,
        fill: false,
        opacity: 0.8,
        strength: 0.5
      },
      {
        id: 'h3',
        start: 12.5,
        end: 16,
        kind: 'rect',
        x: 0.4,
        y: 0.3,
        w: 0.2,
        h: 0.15,
        color: '#30d158',
        strokeWidth: 5,
        fill: false,
        opacity: 1,
        strength: 0.5
      },
      {
        id: 'h4',
        start: 19,
        end: 23,
        kind: 'ellipse',
        x: 0.6,
        y: 0.2,
        w: 0.2,
        h: 0.2,
        color: '#0a84ff',
        strokeWidth: 5,
        fill: true,
        opacity: 0.6,
        strength: 0.5
      },
      {
        id: 'h5',
        start: 21,
        end: 25,
        kind: 'highlight',
        x: 0.1,
        y: 0.7,
        w: 0.4,
        h: 0.06,
        color: '#ffd60a',
        strokeWidth: 4,
        fill: true,
        opacity: 0.5,
        strength: 0.5
      },
      {
        id: 'h6',
        start: 2,
        end: 12,
        kind: 'blur',
        x: 0.7,
        y: 0.7,
        w: 0.2,
        h: 0.15,
        color: '#000000',
        strokeWidth: 4,
        fill: true,
        opacity: 1,
        strength: 0.6
      },
      {
        id: 'h7',
        start: 29,
        end: 39,
        kind: 'pixelate',
        x: 0.05,
        y: 0.05,
        w: 0.15,
        h: 0.1,
        color: '#000000',
        strokeWidth: 4,
        fill: true,
        opacity: 1,
        strength: 0.4
      }
    ],
    annotations: [
      {
        id: 'a1',
        start: 1.5,
        end: 4.5,
        text: 'Click Save',
        x: 0.5,
        y: 0.2,
        size: 0.05,
        style: 'pill'
      },
      {
        id: 'a2',
        start: 13,
        end: 16.5,
        text: 'আমরা আজ শিখব',
        x: 0.3,
        y: 0.8,
        size: 0.06,
        style: 'title'
      },
      {
        id: 'a3',
        start: 34,
        end: 37,
        text: 'مرحبا',
        x: 0.6,
        y: 0.5,
        size: 0.04,
        style: 'pill'
      }
    ],
    titles: [
      {
        id: 't1',
        start: 0.5,
        end: 2.5,
        title: 'Welcome',
        subtitle: 'A tour',
        style: 'centered',
        background: 'blur'
      },
      {
        id: 't2',
        start: 24,
        end: 27.5,
        title: 'Priya Sen',
        subtitle: 'Designer',
        style: 'lower-third',
        background: 'solid',
        color: '#1d1d24'
      },
      {
        id: 't3',
        start: 36,
        end: 39,
        title: 'Thanks',
        style: 'big',
        background: 'style'
      }
    ],
    chapters: [
      { id: 'ch1', t: 0.5, title: 'Start' },
      { id: 'ch2', t: 12, title: 'Export' },
      { id: 'ch3', t: 28, title: 'অধ্যায় তিন' }
    ],
    transcript: {
      language: 'en',
      provider: 'local',
      model: 'speech-small',
      createdAt: '2026-11-01T09:00:00.000Z',
      segments: [
        words('k1', 2, 'Click the Save button now'),
        words('k2', 11, 'Then open the Export dialog'),
        words('k3', 20, 'Sales grew three hundred percent'),
        words('k4', 29, 'That is all for today friends')
      ]
    },
    ...(look ? { captions: { ...p.captions!, studio: look } } : {}),
    graphics,
    bleeps: [{ id: 'b1', start: 21.2, end: 21.6, word: 'damn', sound: 'tone' }],
    effects: {
      ...p.effects,
      motionBlur: 0.6,
      keystrokes: { show: true, position: 'bottom', size: 0.03 }
    },
    audio: {
      ...p.audio,
      fadeIn: 0.5,
      fadeOut: 1,
      ...(music === 'none'
        ? {}
        : {
            music: {
              path: musicFile,
              volume: 0.35,
              ducking: 0.7,
              loop: music !== 'once',
              fadeIn: 1,
              fadeOut: 2
            }
          })
    }
  } as Project
}

function cases(): Case[] {
  const out: Case[] = []
  const old = [...load('vertical-old-projects.json'), ...load('wave8-old-projects.json'), ...load('captions-old-projects.json')]
  old.forEach((f, i) => {
    // 'caption-data' is a captions file's data alone (no style, cursor or size): not a project that draws.
    if (f.name === 'caption-data') return
    const project = migrateProject(structuredClone(f.raw))
    out.push({
      name: `old ${f.name}`,
      project,
      track: seededTrack(rng(7100 + i), project.duration)
    })
  })
  for (const f of sceneFixtures()) out.push({ name: `scene ${f.name}`, project: f.project, track: f.track })
  out.push({
    name: 'everything',
    project: everything('none'),
    track: seededTrack(rng(7201), 40)
  })
  out.push({
    name: 'looped mp3 music',
    project: everything('mp3'),
    track: seededTrack(rng(7202), 40)
  })
  out.push({
    name: 'looped opus music',
    project: everything('opus'),
    track: seededTrack(rng(7202), 40)
  })
  out.push({
    name: 'music played once',
    project: everything('once'),
    track: seededTrack(rng(7204), 40)
  })
  return out
}
const CASES = cases()

/* ---------- the frames ---------- */

const FPS = 30

/**
 * 24 export frames of `project`: the frames at and after every cut, inside every hold and still,
 * and just after the start of every zoom, spotlight, shape, text, title card and graphic (at most
 * 16 of them, evenly), then seeded frames up to 24. Indices into videoFrames at 30 fps.
 */
function sampledFrames(
  project: Project,
  seed: number
): {
  times: number[]
  pictures: number[]
  held: Uint8Array | null
  picked: number[]
} {
  const { times, pictures, held } = videoFrames(project.clips, planOf(project), FPS)
  const n = times.length
  const want = new Set<number>()
  const firstAtOrAfter = (s: number): number => {
    for (let i = 0; i < n; i++) if (times[i] >= s) return i
    return -1
  }
  const add = (i: number): void => {
    if (i >= 0 && i < n) want.add(i)
  }
  project.clips.forEach((c, i) => {
    if (i > 0 && c.start - project.clips[i - 1].end > 1e-6) {
      const at = firstAtOrAfter(c.start)
      add(at - 1)
      add(at)
      add(at + 2)
    }
  })
  if (held) for (let i = 0; i < n; i++) if (held[i] && (i === 0 || !held[i - 1])) add(i + 3)
  for (let i = 1; i < n; i++) if (times[i] === times[i - 1] && times[i - 1] !== times[i - 2]) add(i + 2)
  const items: { start: number }[] = [
    ...project.zooms,
    ...(project.spotlights ?? []),
    ...(project.shapes ?? []),
    ...(project.annotations ?? []),
    ...(project.titles ?? []),
    ...(project.graphics ?? [])
  ]
  for (const it of items) add(firstAtOrAfter(it.start + 0.12))
  let list = [...want].sort((a, b) => a - b)
  if (list.length > 16) list = Array.from({ length: 16 }, (_, k) => list[Math.floor((k * list.length) / 16)])
  const r = rng(seed)
  const picked = new Set(list)
  while (picked.size < Math.min(24, n)) picked.add(Math.floor(r() * n))
  return { times, pictures, held, picked: [...picked].sort((a, b) => a - b) }
}

/** Calls with canvases numbered by first use and canvas arguments named, so only what is drawn where counts. */
function stripped(log: Call[]): unknown[] {
  const order = new Map<number, number>()
  const local = (id: number): number => {
    if (!order.has(id)) order.set(id, order.size)
    return order.get(id)!
  }
  return log.map((c) => ({
    ...c,
    canvas: local(c.canvas),
    args: JSON.stringify(c.args, (_k, v: unknown) => (v && typeof v === 'object' && 'getContext' in v ? `canvas${local((v as unknown as { id: number }).id)}` : v))
  }))
}

interface Drawn {
  scene: Record<string, unknown>
  w: number
  h: number
  src: Record<string, unknown>
}

function sceneOf(c: Case): Drawn {
  const { project } = c
  const view = cropView(project, c.track)
  const scene = {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, project.duration, project.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, project.duration),
    ...(view.crop ? { crop: view.crop } : {})
  }
  const { width: w, height: h } = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  const webcam = project.hasWebcam ? { readyState: 4, videoWidth: 1280, videoHeight: 720 } : null
  const src = {
    screen: {
      readyState: 4,
      videoWidth: project.width,
      videoHeight: project.height
    },
    webcam,
    background: null,
    screenFrame: {
      image: { tag: 'screen frame' },
      width: project.width,
      height: project.height
    },
    ...(webcam
      ? {
          webcamFrame: {
            image: { tag: 'camera frame' },
            width: 1280,
            height: 720
          }
        }
      : {})
  }
  return { scene, w, h, src }
}

/** The digests of the 24 frames' call logs, drawn as the export draws them (picture time, sound time, a held frame sharp). */
function framesOf(c: Case, seed: number, draw: DrawFrame = drawFrame): string[] {
  const { scene, w, h, src } = sceneOf(c)
  const { times, pictures, held, picked } = sampledFrames(c.project, seed)
  const out: string[] = []
  for (const i of picked) {
    const target = canvas()
    const ctx = (target.getContext as (t: string) => unknown)('2d')
    calls.length = 0
    const options = held?.[i] ? { frameInterval: 1 / FPS, blurSamples: 1 } : i % 2 ? { frameInterval: 1 / FPS, blurSamples: 10 } : { blurSamples: 4 }
    draw(ctx, w, h, pictures[i], scene, src, options, times[i])
    out.push(`${i}:${digest(stripped(calls))}`)
  }
  return out
}

/* ---------- the sound ---------- */

/** What main mixes for the job: the parts of the job and the graph planSoundtrack builds (inputs after the video's one). */
async function soundOf(c: Case): Promise<unknown> {
  jobs.length = 0
  const { scene } = sceneOf(c)
  try {
    await exportVideo({
      project: c.project,
      scene,
      screenUrl: 'media://p/screen.mp4',
      webcamUrl: null,
      background: null,
      settings: {
        format: 'm4a',
        resolution: 1080,
        fps: 30,
        quality: 'high',
        encoder: 'software'
      },
      outputPath: '/tmp/out.m4a',
      onProgress: () => undefined,
      signal: new AbortController().signal
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  expect(jobs).toHaveLength(1)
  const { outputPath: _o, ...job } = jobs[0]
  void _o
  // The files main resolved: the proxy's mixed track, the stems, and the music (named apart, §0 decision 2).
  const files = {
    mix: '/p/screen.mp4',
    stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' },
    music: job.music ? `/p/${job.music.file}` : null
  }
  const plan = planSoundtrack(jobs[0], files, 1)
  const args = plan.args.map((a) => (files.music && a === files.music ? '<music>' : a))
  return { job, args, graph: plan.graph, music: files.music }
}

/* ---------- the guard ---------- */

describe('old projects draw and sound as before wave 10 (§19.2)', () => {
  it('covers the old fixtures, the scene fixtures and a project with every item and music', () => {
    expect(CASES.filter((c) => c.name.startsWith('old ')).map((c) => c.name)).toEqual([
      'old 16:9',
      'old 9:16',
      'old 1:1',
      'old publish-pack',
      'old review-mode',
      'old sound-finder',
      'old nw09-speakers',
      'old tall-karaoke',
      'old default-look',
      'old minimal-hidden'
    ])
    expect(CASES).toHaveLength(10 + 12 + 4)
    // The full project has cuts, both freezes, every shape kind, and pops, a ding and a tone.
    const all = CASES.find((c) => c.name === 'everything')!.project
    expect(new Set(all.shapes!.map((s) => s.kind)).size).toBe(7)
    expect(all.freezes!.map((f) => f.sound)).toEqual(['pause', 'continue'])
    expect(all.captions?.studio).toBeDefined()
  })

  CASES.forEach((c, n) => {
    it(`${c.name}: the same 24 frames and the same sound`, async () => {
      const frames = framesOf(c, 9000 + n)
      expect(frames).toHaveLength(24)
      const sound = await soundOf(c)
      const got = { frames: digest(frames), sound: digest(sound) }
      expect(got, c.name).toEqual(SNAPSHOT[c.name])
    })
  })

  it('the looped opus case differs from the mp3 one only by its music file', async () => {
    const mp3 = (await soundOf(CASES.find((c) => c.name === 'looped mp3 music')!)) as { job: ExportJob; graph: string; args: string[] }
    const opus = (await soundOf(CASES.find((c) => c.name === 'looped opus music')!)) as { job: ExportJob; graph: string; args: string[] }
    expect(opus.graph).toBe(mp3.graph)
    expect(opus.args).toEqual(mp3.args)
    expect(opus.job.music?.file).toBe('music-2.opus')
    expect({ ...opus.job, music: { ...opus.job.music, file: 'x' } }).toEqual({
      ...mp3.job,
      music: { ...mp3.job.music, file: 'x' }
    })
  })
})
