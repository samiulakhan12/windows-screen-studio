import { describe, expect, it } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import type { DirectorSpeech } from '../src/shared/audio/speech'
import { applyDirectorPlan, planDirector } from '../src/shared/editor/cameraDirector'
import { PALETTE_COMMANDS, searchCommands } from '../src/shared/editor/commands'
import {
  autoZoomHasInput,
  DEFAULT_POLISH_OPTIONS,
  pickTranscriber,
  planPolish,
  polishAvailability,
  polishKeepRanges,
  readPolishOptions,
  type PolishContext,
  type PolishInput,
  type PolishOptions
} from '../src/shared/editor/polish'
import { BUILT_IN_PRESETS } from '../src/shared/editor/stylePresets'
import { directorSettingsOf } from '../src/shared/engine/directorData'
import { createProject } from '../src/shared/engine/project'
import { outputDuration, sourceToOutput } from '../src/shared/engine/timeline'
import { DEFAULT_ZOOM_SETTINGS, regenerateAutoZooms } from '../src/shared/engine/zoom'
import type { FramingOutcome } from '../src/shared/render/faceFraming'
import type { Clip, CursorSample, CursorTrack, Freeze, LayoutSegment, Project, TitleCard, Transcript, ZoomSegment } from '../src/shared/types'

/*
 * Polish in one click (docs/design/polish-in-one-click.md §10). The silence fixture: 12 s, one
 * clip, heard over 0.3-3.5 and 7.5-11.9 s, no camera. The director fixture is the camera
 * director's e2e one (tests/cameraDirector.test.ts): 48 s with a camera, the cursor resting in
 * the middle until 8 s, then in the bottom-right corner with left clicks at 13-25 s, and talking
 * over 0.5-6, 17-22 and 34-46.5 s.
 */

const SKIPPED: FramingOutcome = { status: 'skipped' }
const SOUND = [
  { start: 0.3, end: 3.5 },
  { start: 7.5, end: 11.9 }
]
/** Every step off: tests turn on the ones they look at. */
const NONE: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, styleId: null, zoom: false, silences: false, captions: false, director: false }

function counter(prefix = 'a'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

/** A valid track with the cursor drifting right (as tests/smartSpeed.test.ts builds it). */
function track(duration: number, extra: Partial<CursorTrack> = {}): CursorTrack {
  const samples: CursorSample[] = []
  for (let t = 0, x = 0.2; t <= duration + 1e-9; t += 1 / 30, x += 0.001) samples.push({ t: +t.toFixed(4), x, y: 0.5 })
  return { samples, clicks: [], keys: [], valid: true, ...extra }
}

const NO_INPUT: CursorTrack = { samples: [], clicks: [], keys: [], valid: false }

function project12(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p12',
    name: 'p12',
    duration: 12,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  return { ...p, clips: [{ id: 'c0', start: 0, end: 12, speed: 1 }], ...over }
}

const input12 = (over: Partial<PolishInput> = {}): PolishInput => ({
  project: project12(),
  recorded: NO_INPUT,
  sound: SOUND,
  transcript: null,
  speech: null,
  framing: SKIPPED,
  preset: null,
  ...over
})

const spans = (clips: Clip[]): [number, number, number][] => clips.map((c) => [+c.start.toFixed(4), +c.end.toFixed(4), c.speed])
const stepOf = (r: ReturnType<typeof planPolish>, step: string) => r.summary.steps.find((s) => s.step === step)

/** Auto zoom turned off as the toggle writes it. */
const autoOff = (p: Project): Project => ({ ...p, autoZoom: false, zoomSettings: { ...DEFAULT_ZOOM_SETTINGS, auto: { ...DEFAULT_ZOOM_SETTINGS.auto, enabled: false } } })

/* ---------- the director fixture ---------- */

function e2eProject(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 48,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  p.style = { ...p.style, padding: 0 }
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  return { ...p, clips: [{ id: 'c0', start: 0, end: 48, speed: 1 }], ...over }
}

function e2eCursor(): CursorTrack {
  const samples: CursorSample[] = []
  for (let i = 0; i <= 480; i++) {
    const t = i / 10
    const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
    samples.push({ t, x: 0.5 + 0.42 * k, y: 0.5 + 0.4 * k })
  }
  return { samples, clicks: [13, 16, 19, 22, 25].map((t) => ({ t, x: 0.92, y: 0.9, button: 'left' as const })), valid: true }
}
const CURSOR = e2eCursor()

const TALK = [
  { start: 0.5, end: 6 },
  { start: 17, end: 22 },
  { start: 34, end: 46.5 }
]
const SPEECH: DirectorSpeech = { source: 'mic', refined: false, ranges: TALK }

const directorInput = (over: Partial<PolishInput> = {}): PolishInput => ({
  project: e2eProject(),
  recorded: CURSOR,
  sound: TALK,
  transcript: null,
  speech: SPEECH,
  framing: SKIPPED,
  preset: null,
  newId: counter(),
  ...over
})

const transcript = (n: number): Transcript => ({
  provider: 'openai',
  model: 'whisper-1',
  createdAt: '2026-10-26T00:00:00.000Z',
  segments: Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, start: 1 + i, end: 1.8 + i, text: `Word ${i}` }))
})

const STUDIO = BUILT_IN_PRESETS.find((p) => p.id === 'studio')!

describe('planPolish: remove silences', () => {
  it('cuts the pause with the Clip panel defaults, keeping a quarter second next to the sound', () => {
    const r = planPolish(input12(), { ...NONE, silences: true })
    expect(spans(r.project.clips)).toEqual([
      [0, 3.75, 1],
      [7.25, 12, 1]
    ])
    expect(r.summary.saved).toBeCloseTo(3.5, 6)
    expect(r.summary.silences).toBe(1)
    expect(stepOf(r, 'silences')).toEqual({ step: 'silences', status: 'changed' })
    // Neither end gap counts: 0.3 s at the start, 0.1 s at the end.
    expect(r.project.clips[0].start).toBe(0)
    expect(r.project.clips[1].end).toBe(12)
  })

  it('speeds the pause up instead with a speed action', () => {
    const r = planPolish(input12(), { ...NONE, silences: true, silenceAction: 4 })
    expect(spans(r.project.clips)).toEqual([
      [0, 3.75, 1],
      [3.75, 7.25, 4],
      [7.25, 12, 1]
    ])
    expect(r.summary.saved).toBeCloseTo(3.5 - 3.5 / 4, 6)
    expect(r.summary.silenceAction).toBe(4)
  })

  it('keeps title cards: their time counts as sound', () => {
    const titles = [{ id: 't', start: 4, end: 6, title: 'Hi' } as TitleCard]
    const r = planPolish(input12({ project: project12({ titles }) }), { ...NONE, silences: true })
    // [3.5, 4] is too short; [6, 7.5] loses its padding to [6.25, 7.25].
    expect(spans(r.project.clips)).toEqual([
      [0, 6.25, 1],
      [7.25, 12, 1]
    ])
    expect(r.summary.saved).toBeCloseTo(1, 6)
  })

  it('skips without measured sound, without anything heard, and when muted', () => {
    const base = input12()
    const heard = planPolish({ ...base, sound: [] }, { ...NONE, silences: true })
    expect(stepOf(heard, 'silences')).toEqual({ step: 'silences', status: 'skipped', reason: 'nothing-heard' })
    expect(heard.project).toBe(base.project)
    expect(stepOf(planPolish({ ...base, sound: null }, { ...NONE, silences: true }), 'silences')?.reason).toBe('not-measured')
    const muted = project12({ audio: { ...project12().audio, muted: true } })
    expect(stepOf(planPolish({ ...base, project: muted }, { ...NONE, silences: true }), 'silences')?.reason).toBe('muted')
    expect(stepOf(planPolish({ ...base, project: project12({ hasAudio: false }) }, { ...NONE, silences: true }), 'silences')?.reason).toBe('no-sound')
  })

  it('a second run finds nothing more: the pause left is the padding', () => {
    for (const silenceAction of ['cut', 4] as const) {
      const options = { ...NONE, silences: true, silenceAction }
      const once = planPolish(input12(), options).project
      const again = planPolish(input12({ project: once }), options)
      expect(again.project).toBe(once)
      expect(stepOf(again, 'silences')?.status).toBe('unchanged')
      expect(again.summary.saved).toBe(0)
    }
  })
})

describe('planPolish: auto zoom', () => {
  const clicks = [2.2, 9].map((t) => ({ t, x: 0.4, y: 0.6, button: 'left' as const }))
  const recorded = track(12, { clicks })
  const manual: ZoomSegment = { id: 'mine', start: 10.8, end: 11.8, scale: 1.5, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }
  const noId = (zs: ZoomSegment[]): Omit<ZoomSegment, 'id'>[] => zs.map(({ id: _id, ...z }) => (void _id, z))

  it('turns auto zoom on as the toggle does, keeping your zooms', () => {
    const project = autoOff(project12({ zooms: [manual] }))
    const r = planPolish(input12({ project, recorded }), { ...NONE, zoom: true })
    const p = r.project
    expect(stepOf(r, 'zoom')?.status).toBe('changed')
    expect(p.autoZoom).toBe(true)
    expect(p.zoomSettings?.auto.enabled).toBe(true)
    expect(p.zooms.find((z) => z.id === 'mine')).toBe(manual)
    const want = regenerateAutoZooms(project.zooms, recorded, 12, { ...DEFAULT_ZOOM_SETTINGS.auto, enabled: true }).zooms
    expect(noId(p.zooms)).toEqual(noId(want))
    expect(p.zooms.filter((z) => z.auto).length).toBe(2)
    expect(r.summary.zooms).toEqual({ auto: 2, kept: 1 })
  })

  it('leaves the zooms alone while auto zoom is on (a zoom you deleted stays deleted)', () => {
    const first = planPolish(input12({ project: autoOff(project12()), recorded }), { ...NONE, zoom: true }).project
    const deleted = { ...first, zooms: first.zooms.slice(1) }
    const r = planPolish(input12({ project: deleted, recorded }), { ...NONE, zoom: true })
    expect(stepOf(r, 'zoom')?.status).toBe('unchanged')
    expect(r.project).toBe(deleted)
    expect(r.project.zooms).toBe(deleted.zooms)
  })

  it('needs clicks, typing or marks', () => {
    const r = planPolish(input12({ project: autoOff(project12()), recorded: track(12) }), { ...NONE, zoom: true })
    expect(stepOf(r, 'zoom')).toEqual({ step: 'zoom', status: 'skipped', reason: 'no-input' })
    expect(autoZoomHasInput(track(12))).toBe(false)
    expect(autoZoomHasInput(track(12, { clicks: [{ t: 1, x: 0.5, y: 0.5, button: 'right' }] }))).toBe(true)
    expect(autoZoomHasInput(track(12, { clicks: [{ t: 1, x: 1.5, y: 0.5, button: 'left' }] }))).toBe(false)
    expect(autoZoomHasInput(track(12, { typing: [{ t: 1, end: 3 }] }))).toBe(true)
    // Without cursor data only the marks count, as in the Zoom tab.
    expect(autoZoomHasInput({ ...NO_INPUT, typing: [{ t: 1, end: 3 }] })).toBe(false)
    expect(autoZoomHasInput({ ...NO_INPUT, marks: [{ t: 4 }] })).toBe(true)
  })
})

describe('planPolish: camera director', () => {
  const options: PolishOptions = { ...NONE, silences: true, director: true }

  it('plans on the polished cuts, as Direct again does, and keeps your blocks', () => {
    const mine: LayoutSegment = { id: 'mine', start: 18, end: 21, layout: 'screen-only' }
    const project = e2eProject({ layouts: [mine] })
    const cut = planPolish(directorInput({ project }), { ...options, director: false }).project
    expect(cut.clips.length).toBeGreaterThan(1)
    const r = planPolish(directorInput({ project }), options)
    const plan = planDirector({ project: cut, cursor: CURSOR, speech: SPEECH, newId: counter() }, directorSettingsOf(cut))
    expect(r.project.layouts).toEqual(applyDirectorPlan(cut, plan, SKIPPED).layouts)
    expect(spans(r.project.clips)).toEqual(spans(cut.clips))
    expect(r.project.layouts?.find((s) => s.id === 'mine')).toEqual(mine)
    const count = (kind: string): number => plan.parts.filter((x) => x.kind === kind).length
    expect(plan.parts.length).toBeGreaterThan(0)
    expect(r.summary.camera).toEqual({ intro: count('intro') > 0, outro: count('outro') > 0, hidden: count('hidden'), moves: count('corner') })
    expect(r.summary.framing).toBe(SKIPPED)
    expect(r.directorPlan?.parts).toEqual(plan.parts)
    expect(stepOf(r, 'director')?.status).toBe('changed')
  })

  it('skips without a camera, with the camera hidden, and when the runner says so', () => {
    const noCamera = e2eProject({ hasWebcam: false })
    const r = planPolish(directorInput({ project: noCamera }), { ...NONE, director: true })
    expect(stepOf(r, 'director')).toEqual({ step: 'director', status: 'skipped', reason: 'no-camera' })
    expect(r.project).toBe(noCamera)
    expect(r.project.director).toBeUndefined()
    expect(r.directorPlan).toBeNull()
    const hidden = e2eProject()
    hidden.webcam = { ...hidden.webcam, show: false }
    expect(stepOf(planPolish(directorInput({ project: hidden }), { ...NONE, director: true }), 'director')?.reason).toBe('camera-hidden')
    const missing = planPolish(directorInput({ blocked: { director: 'no-camera' } }), { ...NONE, director: true })
    expect(stepOf(missing, 'director')?.reason).toBe('no-camera')
  })

  it('applies the face framing it is given', () => {
    const framed: FramingOutcome = { status: 'framed', zoom: 1.25, cropX: 0.6, cropY: 0.4, found: 6, sampled: 6, steady: true }
    const r = planPolish(directorInput({ framing: framed }), { ...NONE, director: true })
    expect(r.project.webcam).toMatchObject({ zoom: 1.25, cropX: 0.6, cropY: 0.4 })
    expect(r.summary.framing).toBe(framed)
  })
})

describe('planPolish: captions', () => {
  it('writes the fetched transcript and shows the captions', () => {
    const t = transcript(3)
    const r = planPolish(input12({ transcript: t }), { ...NONE, captions: true })
    expect(r.project.transcript).toBe(t)
    expect(r.project.captions?.show).toBe(true)
    expect(r.summary.captions).toBe(3)
    expect(r.summary.captionsLeftOutAfter).toBeNull()
    expect(stepOf(r, 'captions')?.status).toBe('changed')
  })

  it('never replaces captions you have', () => {
    const had = project12({ transcript: transcript(2) })
    const r = planPolish(input12({ project: had, transcript: transcript(3) }), { ...NONE, captions: true })
    expect(r.project).toBe(had)
    expect(stepOf(r, 'captions')).toEqual({ step: 'captions', status: 'skipped', reason: 'has-captions' })
  })

  it('a failed transcription skips captions only; the other steps still apply', () => {
    const r = planPolish(input12({ blocked: { captions: 'failed' }, errors: { captions: 'No credits or quota left' } }), { ...NONE, captions: true, silences: true })
    expect(stepOf(r, 'captions')).toEqual({ step: 'captions', status: 'skipped', reason: 'failed', error: 'No credits or quota left' })
    expect(stepOf(r, 'silences')?.status).toBe('changed')
    expect(r.project.transcript).toBeUndefined()
    // No transcript and no reason: it failed.
    expect(stepOf(planPolish(input12(), { ...NONE, captions: true }), 'captions')?.reason).toBe('failed')
    expect(stepOf(planPolish(input12({ blocked: { captions: 'cancelled' } }), { ...NONE, captions: true }), 'captions')?.reason).toBe('cancelled')
  })

  it('says where captions left out start, on the polished cuts', () => {
    const t = transcript(9)
    const r = planPolish(input12({ transcript: t, transcriptLeftOut: true }), { ...NONE, captions: true, silences: true })
    // The last caption ends at 9.8 s of the recording: 3.5 s of the pause before it are cut.
    expect(r.summary.captionsLeftOutAfter).toBeCloseTo(9.8 - 3.5, 6)
  })
})

describe('planPolish: style', () => {
  const preset = { name: STUDIO.name, look: STUDIO.look }

  it('applies a preset and keeps the aspect ratio', () => {
    const p = project12({ style: { ...project12().style, aspectRatio: '16:9' } })
    const r = planPolish(input12({ project: p, preset }), { ...NONE, styleId: 'studio' })
    expect(r.project.style.background).toEqual({ type: 'wallpaper', id: 'violet-mesh' })
    expect(r.project.style.aspectRatio).toBe('16:9')
    expect(r.summary.style).toBe('Studio')
    expect(stepOf(r, 'style')?.status).toBe('changed')
    const again = planPolish(input12({ project: r.project, preset }), { ...NONE, styleId: 'studio' })
    expect(again.project).toBe(r.project)
    expect(stepOf(again, 'style')?.status).toBe('unchanged')
    expect(again.summary.style).toBe('Studio')
  })

  it('reports a preset that is gone, and a look with nothing in it changes nothing', () => {
    expect(stepOf(planPolish(input12(), { ...NONE, styleId: 'gone' }), 'style')).toEqual({ step: 'style', status: 'skipped', reason: 'no-preset' })
    const base = input12({ preset: { name: 'Empty', look: { style: {}, cursor: {}, zoom: {} } } })
    const r = planPolish(base, { ...NONE, styleId: 'u1' })
    expect(r.project).toBe(base.project)
    expect(stepOf(r, 'style')?.status).toBe('unchanged')
    expect(r.summary.style).toBeNull()
  })
})

describe('planPolish: the whole run', () => {
  const all: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, styleId: 'studio' }
  const withAll = (over: Partial<PolishInput> = {}): PolishInput =>
    directorInput({ project: autoOff(e2eProject()), preset: { name: STUDIO.name, look: STUDIO.look }, transcript: transcript(4), ...over })

  it('reports every step in run order', () => {
    const base = withAll()
    const r = planPolish(base, all)
    expect(r.summary.steps.map((s) => [s.step, s.status])).toEqual([
      ['style', 'changed'],
      ['zoom', 'changed'],
      ['silences', 'changed'],
      ['captions', 'changed'],
      ['director', 'changed']
    ])
    expect(r.summary.saved).toBeCloseTo(outputDuration(base.project.clips) - outputDuration(r.project.clips), 6)
  })

  it('is idempotent: polishing the result again changes nothing', () => {
    const once = planPolish(withAll(), all)
    const again = planPolish(withAll({ project: once.project, newId: counter('b') }), all)
    expect(again.project).toBe(once.project)
    expect(again.summary.steps.every((s) => s.status !== 'changed')).toBe(true)
    expect(again.summary.saved).toBe(0)
  })

  it('with every step off returns the project itself', () => {
    const base = withAll()
    const r = planPolish(base, NONE)
    expect(r.project).toBe(base.project)
    expect(r.summary.steps.every((s) => s.status === 'skipped' && s.reason === 'off')).toBe(true)
    expect(r.directorPlan).toBeNull()
  })

  it('carries the crop and the freeze frames through, and never cuts a freeze', () => {
    const crop = { x: 0, y: 0, w: 1, h: 0.9 }
    const freezes: Freeze[] = [
      { id: 'f1', at: 10, length: 3, sound: 'pause' },
      { id: 'f2', at: 28, length: 2, sound: 'continue' }
    ]
    const r = planPolish(withAll({ project: autoOff(e2eProject({ crop, freezes })) }), all)
    expect(r.project.crop).toBe(crop)
    expect(r.project.freezes).toBe(freezes)
    expect(stepOf(r, 'silences')?.status).toBe('changed')
    // Both anchors are silent (between the talking) and still in the video.
    for (const f of freezes) expect(sourceToOutput(r.project.clips, f.at), `freeze at ${f.at}`).not.toBeNull()
    // The same project without freezes cuts them away.
    const plain = planPolish(withAll({ project: autoOff(e2eProject({ crop })) }), all)
    expect(sourceToOutput(plain.project.clips, 28)).toBeNull()
  })

  it('keeps a quarter second around each freeze, with the title cards', () => {
    const p = project12({
      titles: [{ id: 't', start: 1, end: 2, title: 'Hi' } as TitleCard],
      freezes: [{ id: 'f', at: 5, length: 3, sound: 'pause' }]
    })
    expect(polishKeepRanges(p)).toEqual([
      { start: 1, end: 2 },
      { start: 4.75, end: 5.25 }
    ])
    const r = planPolish(input12({ project: p }), { ...NONE, silences: true })
    // The pause 3.5-7.5 s around the freeze: 3.75-4.5 and 5.5-7.25 are cut.
    expect(spans(r.project.clips)).toEqual([
      [0, 3.75, 1],
      [4.5, 5.5, 1],
      [7.25, 12, 1]
    ])
  })
})

describe('readPolishOptions', () => {
  it('sanitises the remembered options', () => {
    for (const raw of [null, [], 'x']) expect(readPolishOptions(raw)).toEqual(DEFAULT_POLISH_OPTIONS)
    expect(readPolishOptions({ silenceAction: 3 }).silenceAction).toBe('cut')
    expect(readPolishOptions({ styleId: 5 }).styleId).toBeNull()
    expect(readPolishOptions({ captionsProvider: 'x'.repeat(65) }).captionsProvider).toBeNull()
    const read = readPolishOptions({ styleId: 'u1', zoom: false, silenceAction: 8, captionsProvider: 'p1', director: false })
    expect(read).toEqual({ ...DEFAULT_POLISH_OPTIONS, styleId: 'u1', zoom: false, silenceAction: 8, captionsProvider: 'p1', director: false })
    expect(readPolishOptions(read)).toEqual(read)
  })
})

describe('polishAvailability', () => {
  const ctx: PolishContext = { hasCameraFile: true, transcribers: [{ id: 'o' }], transcribing: false }
  const recorded = track(12, { clicks: [{ t: 1, x: 0.5, y: 0.5, button: 'left' }] })

  it('offers every step of a recording that has everything', () => {
    expect(polishAvailability(e2eProject(), recorded, ctx)).toEqual({ style: null, zoom: null, silences: null, captions: null, director: null })
  })

  it('says why a row is disabled', () => {
    const silent = polishAvailability(project12({ hasAudio: false }), recorded, ctx)
    expect([silent.silences, silent.captions]).toEqual(['no-sound', 'no-sound'])
    const muted = polishAvailability(project12({ audio: { ...project12().audio, muted: true } }), recorded, ctx)
    expect([muted.silences, muted.captions]).toEqual(['muted', null])
    expect(polishAvailability(project12({ transcript: transcript(1) }), recorded, ctx).captions).toBe('has-captions')
    expect(polishAvailability(project12(), recorded, { ...ctx, transcribing: true }).captions).toBe('busy')
    expect(polishAvailability(project12(), recorded, { ...ctx, transcribers: [] }).captions).toBe('no-provider')
    expect(polishAvailability(project12(), recorded, { ...ctx, transcribers: null }).captions).toBeNull()
    expect(polishAvailability(project12(), track(12), ctx).zoom).toBe('no-input')
    expect(polishAvailability(e2eProject(), recorded, { ...ctx, hasCameraFile: false }).director).toBe('no-camera')
    expect(polishAvailability(project12(), recorded, ctx).director).toBe('no-camera')
    const hidden = e2eProject()
    hidden.webcam = { ...hidden.webcam, show: false }
    expect(polishAvailability(hidden, recorded, ctx).director).toBe('camera-hidden')
  })
})

describe('pickTranscriber', () => {
  const provider = (id: string, kind: AiProviderInfo['kind'], transcriptionModel?: string): AiProviderInfo => ({
    id,
    kind,
    label: id,
    model: 'm',
    maskedKey: '…0000',
    ...(transcriptionModel ? { transcriptionModel } : {})
  }) as AiProviderInfo

  it('takes the remembered provider while it can transcribe, else the first that can', () => {
    const claude = provider('c', 'anthropic')
    const openai = provider('o', 'openai', 'whisper-1')
    const gemini = provider('g', 'gemini', 'gemini-2.5-flash')
    expect(pickTranscriber([claude], null)).toBeNull()
    expect(pickTranscriber([claude, openai, gemini], 'g')).toBe(gemini)
    expect(pickTranscriber([claude, openai, gemini], 'gone')).toBe(openai)
    expect(pickTranscriber([claude, openai], 'c')).toBe(openai)
  })
})

describe('the polish command', () => {
  it('is found by what it does', () => {
    const titles = (q: string): string[] => searchCommands(PALETTE_COMMANDS, q, []).map((r) => r.command.title)
    expect(titles('polish')[0]).toBe('Polish in one click…')
    for (const q of ['magic', 'remove silences', 'one click']) expect(titles(q), q).toContain('Polish in one click…')
  })
})
