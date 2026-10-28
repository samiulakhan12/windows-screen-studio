import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import type { DuplicateProgress, DuplicateResult, ProjectsApi } from '../src/shared/api/projects'
import * as captionLayoutModule from '../src/shared/captions/layout'
import { COMMAND_IDS, commandInfo, PALETTE_COMMANDS, type CommandId } from '../src/shared/editor/commands'
import * as duplicate from '../src/shared/editor/duplicate'
import * as followEdit from '../src/shared/editor/followEdit'
import { checkShortcut, DEFAULT_KEYMAP, findConflicts, reservedReason } from '../src/shared/editor/shortcuts'
import * as frameViewModule from '../src/shared/engine/frameView'
import * as layout from '../src/shared/engine/layout'
import { migrateProject } from '../src/shared/engine/project'
import * as reframe from '../src/shared/engine/reframe'
import * as reframeData from '../src/shared/engine/reframeData'
import * as watermark from '../src/shared/engine/watermark'
import * as zoom from '../src/shared/engine/zoom'
import * as overlays from '../src/shared/render/overlays'
import * as safeZones from '../src/shared/render/safeZones'
import * as titleCards from '../src/shared/render/titleCards'
import type { AutoZoomSettings, CameraLayout, CaptionSegment, CaptionSettings, Corner, CursorTrack, NormRect, Project, ProjectCopyOf, ReframeSettings, TitleCard, WatermarkSettings, ZoomSegment } from '../src/shared/types'

/*
 * The contracts of vertical video and Duplicate (docs/design/vertical-video.md §9.0, test 66):
 * the settings and their sanitising (reframeData.ts, written in full), every export the four parts
 * write with its arity (stubs until then), the frozen data (the Movement constants, the safe-zone
 * table, the linked media), the six commands with R and G, and the API. The signatures are also
 * checked by the typecheck (tests/ are in tsconfig.node.json): a part that changes one breaks it.
 */

/* ---------- reframeData.ts: the settings, in full ---------- */

describe('reframe settings (reframeData.ts)', () => {
  const { DEFAULT_REFRAME, FOLLOW_NARROWER, REFRAME_LIMITS, TALL, canFollow, followApplies, isTall, readCopyOf, readReframe, reframeOn, withReframe, withoutFollow } = reframeData

  it('has the defaults and limits of §4.2, frozen', () => {
    expect(REFRAME_LIMITS).toEqual({ level: { min: 1, max: 2, step: 0.05 }, band: { min: 0.2, max: 0.5, step: 0.01 } })
    expect(FOLLOW_NARROWER).toBe(0.9)
    expect(TALL).toBe(1.25)
    expect(DEFAULT_REFRAME).toEqual({ mode: 'follow', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: true })
    expect(Object.isFrozen(DEFAULT_REFRAME)).toBe(true)
  })

  it('readReframe: absent or not a plain object gives nothing; damage never turns following on or moves captions', () => {
    for (const raw of [undefined, null, [], 'follow', 3, true]) expect(readReframe(raw)).toBeUndefined()
    expect(readReframe({})).toEqual({ mode: 'fit', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: false })
    expect(readReframe({ mode: 'x' })?.mode).toBe('fit')
    expect(readReframe({ mode: 'follow' })?.mode).toBe('follow')
    expect(readReframe({ level: 9 })?.level).toBe(2)
    expect(readReframe({ level: 0.2 })?.level).toBe(1)
    expect(readReframe({ level: Number.NaN })?.level).toBe(1)
    expect(readReframe({ level: 1.35 })?.level).toBe(1.35)
    expect(readReframe({ band: 0 })?.band).toBe(0.2)
    expect(readReframe({ band: 0.7 })?.band).toBe(0.5)
    expect(readReframe({ band: '0.3' })?.band).toBe(0.32)
    expect(readReframe({ camera: 'left' })?.camera).toBe('top')
    expect(readReframe({ camera: 'bottom' })?.camera).toBe('bottom')
    expect(readReframe({ pace: 'fast' })?.pace).toBe('balanced')
    expect(readReframe({ pace: 'lively' })?.pace).toBe('lively')
    expect(readReframe({ appSafe: 'yes' })?.appSafe).toBe(false)
    expect(readReframe({ appSafe: true })?.appSafe).toBe(true)
  })

  it('readReframe keeps a rest point only with finite x and y, clamped, and is idempotent', () => {
    expect(readReframe({ rest: { x: 2, y: Number.NaN } })).not.toHaveProperty('rest')
    expect(readReframe({ rest: { x: 2, y: 0.5 } })?.rest).toEqual({ x: 1, y: 0.5 })
    expect(readReframe({ rest: { x: -1, y: 0.25 } })?.rest).toEqual({ x: 0, y: 0.25 })
    expect(readReframe({ rest: [0.5, 0.5] })).not.toHaveProperty('rest')
    expect(readReframe({ rest: { x: 0.5 } })).not.toHaveProperty('rest')
    for (const raw of [{}, { mode: 'follow', level: 7, camera: 'bubble', band: -1, pace: 'calm', appSafe: true, rest: { x: 3, y: -2 } }, { mode: 'nope', rest: 'x' }]) {
      const once = readReframe(raw)
      expect(readReframe(once)).toEqual(once)
    }
  })

  it('readCopyOf: a folder id and a name, the name cut to 200', () => {
    expect(readCopyOf({ id: 'rec-20261012-101500', name: 'Billing demo' })).toEqual({ id: 'rec-20261012-101500', name: 'Billing demo' })
    for (const raw of [undefined, null, [], { id: '../x', name: 'a' }, { id: 'a b', name: 'a' }, { id: '', name: 'a' }, { id: 'rec-1', name: 3 }, { id: 4, name: 'a' }]) expect(readCopyOf(raw)).toBeUndefined()
    expect(readCopyOf({ id: 'rec-1', name: 'n'.repeat(300) })?.name).toHaveLength(200)
  })

  it('reframeOn: the defaults in a tall frame, the bubble and no app-safe text otherwise; existing settings keep all but the mode', () => {
    expect(reframeOn({}, 1080, 1920)).toEqual(DEFAULT_REFRAME)
    expect(reframeOn({}, 1080, 1080)).toEqual({ ...DEFAULT_REFRAME, camera: 'bubble', appSafe: false })
    const mine: ReframeSettings = { mode: 'fit', level: 1.5, camera: 'bottom', band: 0.4, pace: 'calm', appSafe: false, rest: { x: 0.2, y: 0.3 } }
    expect(reframeOn({ reframe: mine }, 1080, 1080)).toEqual({ ...mine, mode: 'follow' })
    expect(Object.isFrozen(reframeOn({}, 1080, 1920))).toBe(false)
  })

  it('followApplies: following in a frame at least 10% narrower than the drawn recording', () => {
    const on = { reframe: { ...DEFAULT_REFRAME } }
    expect(followApplies(on, 1080, 1920, 1920, 1080)).toBe(true)
    expect(followApplies(on, 1920, 1080, 1920, 1080)).toBe(false)
    expect(followApplies(on, 1080, 1080, 1440, 1080)).toBe(true)
    expect(followApplies(on, 1080, 1080, 1200, 1080)).toBe(false)
    expect(followApplies(on, 1440, 1080, 1920, 1080)).toBe(true)
    expect(followApplies(on, 1080, 1920, 1080, 1920)).toBe(false)
    expect(followApplies({ reframe: { ...DEFAULT_REFRAME, mode: 'fit' } }, 1080, 1920, 1920, 1080)).toBe(false)
    expect(followApplies({}, 1080, 1920, 1920, 1080)).toBe(false)
    expect(followApplies(on, 1080, 1920, 0, 0)).toBe(false)
  })

  it('canFollow: 9:16, 1:1 and 4:3 of a 16:9 recording; not 16:9, auto, or a tall recording in 9:16', () => {
    expect(['9:16', '1:1', '4:3', '16:9', 'auto'].map((a) => canFollow(a as Project['style']['aspectRatio'], 1920, 1080))).toEqual([true, true, true, false, false])
    expect(canFollow('1:1', 1200, 900)).toBe(true)
    expect(canFollow('9:16', 1080, 1920)).toBe(false)
    expect(canFollow('9:16', 0, 0)).toBe(false)
  })

  it('isTall, withReframe and withoutFollow', () => {
    expect(isTall(1080, 1920)).toBe(true)
    expect(isTall(1080, 1350)).toBe(true)
    expect(isTall(1080, 1080)).toBe(false)
    const p = migrateProject({ id: 'p', duration: 4, width: 1920, height: 1080, style: { aspectRatio: '9:16', padding: 0, cornerRadius: 0, shadow: 0 } })
    const q = withReframe(p, { level: 1.5 })
    expect(q.reframe).toEqual({ ...DEFAULT_REFRAME, level: 1.5 })
    expect(p).not.toHaveProperty('reframe')
    const r = withReframe(withReframe(q, { rest: { x: 0.1, y: 0.2 } }), { rest: undefined })
    expect(r.reframe).not.toHaveProperty('rest')
    expect(withoutFollow(p)).toBe(p)
    expect(withoutFollow(q)).not.toHaveProperty('reframe')
    expect(withoutFollow(q)).toEqual(p)
  })

  it('migrateProject keeps sanitised settings and the copy origin, and adds no key when they are absent', () => {
    const base = { id: 'p', duration: 4, width: 1920, height: 1080 }
    const p = migrateProject({ ...base, reframe: { mode: 'follow', level: 5, camera: 'bottom', band: 0.3, pace: 'calm', appSafe: true, rest: { x: 0.1, y: 2 } }, copyOf: { id: 'rec-1', name: 'Old' } })
    expect(p.reframe).toEqual({ mode: 'follow', level: 2, camera: 'bottom', band: 0.3, pace: 'calm', appSafe: true, rest: { x: 0.1, y: 1 } })
    expect(p.copyOf).toEqual({ id: 'rec-1', name: 'Old' })
    const broken = migrateProject({ ...base, reframe: { mode: 'yes' }, copyOf: { id: '../../x', name: 'Old' } })
    expect(broken.reframe?.mode).toBe('fit')
    expect(broken.reframe?.appSafe).toBe(false)
    expect(broken).not.toHaveProperty('copyOf')
    const plain = migrateProject({ ...base, reframe: 'follow', copyOf: null })
    expect(plain).not.toHaveProperty('reframe')
    expect(plain).not.toHaveProperty('copyOf')
    // Saved and opened again: the same settings.
    expect(migrateProject(JSON.parse(JSON.stringify(p))).reframe).toEqual(p.reframe)
  })
})

/* ---------- every export of §9 exists, with its arity ---------- */

/** [name, required parameters, all parameters]: Function.length counts up to the first default, so it lies between the two. */
type Arity = [string, number, number]

function expectExports(module: Record<string, unknown>, list: Arity[]): void {
  for (const [name, required, all] of list) {
    const fn = module[name]
    expect(typeof fn, name).toBe('function')
    const n = (fn as (...a: unknown[]) => unknown).length
    expect(n, `${name} takes ${required}..${all} parameters`).toBeGreaterThanOrEqual(required)
    expect(n, `${name} takes ${required}..${all} parameters`).toBeLessThanOrEqual(all)
  }
}

// Renderer and main code: imported at run time, so the Node typecheck of tests/ does not follow it.
const load = (file: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ file)

describe('every export of §9 exists with its arity (test 66)', () => {
  it('P1 engine: layout.ts, zoom.ts, reframe.ts, frameView.ts', () => {
    expectExports(layout as unknown as Record<string, unknown>, [
      ['baseView', 4, 4],
      ['virtualRect', 2, 2],
      ['intersectRect', 2, 2],
      ['followGeometry', 6, 7],
      ['bandSide', 5, 5],
      ['sceneLayout', 6, 6]
    ])
    expectExports(zoom as unknown as Record<string, unknown>, [
      ['typingSessionsOf', 2, 2],
      ['zoomTargetScale', 1, 2],
      ['clampCamera', 1, 2],
      ['cameraFor', 3, 4],
      ['blendCameras', 3, 4],
      ['cameraAt', 3, 5]
    ])
    expectExports(reframe as unknown as Record<string, unknown>, [
      ['glide', 2, 2],
      ['glideInverse', 2, 2],
      ['panDuration', 1, 2],
      ['followLimits', 1, 1],
      ['framedZooms', 2, 2],
      ['followAttention', 2, 2],
      ['planFollow', 2, 2],
      ['followPlanFor', 2, 2],
      ['followCentre', 2, 3]
    ])
    expectExports(frameViewModule as unknown as Record<string, unknown>, [
      ['drawnForFrame', 5, 5],
      ['frameCamera', 3, 4],
      ['frameView', 6, 7],
      ['followGain', 6, 6],
      ['narrowBoxZoom', 2, 2],
      ['viewMagnification', 5, 5]
    ])
    expectExports(reframeData as unknown as Record<string, unknown>, [
      ['readReframe', 1, 1],
      ['readCopyOf', 1, 1],
      ['reframeOn', 3, 3],
      ['followApplies', 5, 5],
      ['canFollow', 3, 3],
      ['isTall', 2, 2],
      ['withReframe', 2, 2],
      ['withoutFollow', 1, 1]
    ])
  })

  it('P2 placement: captions, watermark, titles, overlays and safeZones.ts', () => {
    expectExports(captionLayoutModule as unknown as Record<string, unknown>, [
      ['captionMetrics', 3, 4],
      ['captionLayout', 5, 6],
      ['placeChunk', 5, 6]
    ])
    expectExports(watermark as unknown as Record<string, unknown>, [['watermarkRect', 4, 5]])
    expectExports(titleCards as unknown as Record<string, unknown>, [['titleLayout', 4, 5]])
    expectExports(overlays as unknown as Record<string, unknown>, [['cameraDisplacement', 3, 4]])
    expectExports(safeZones as unknown as Record<string, unknown>, [
      ['zonesFor', 1, 1],
      ['textArea', 6, 6],
      ['keepInArea', 2, 3]
    ])
  })

  it('P3 editor: followEdit.ts', () => {
    expectExports(followEdit as unknown as Record<string, unknown>, [
      ['holdViewAt', 4, 4],
      ['dragView', 5, 5],
      ['followStatus', 4, 4]
    ])
  })

  it('P4 duplicate: duplicate.ts and the main process projectCopy.ts', async () => {
    expectExports(duplicate as unknown as Record<string, unknown>, [
      ['copyName', 2, 2],
      ['canCopyAs', 4, 4],
      ['projectCopy', 3, 3],
      ['refitItems', 5, 5]
    ])
    const main = await load('../src/main/projectCopy')
    expectExports(main, [
      ['copiedFile', 1, 1],
      ['linkAllowed', 1, 2],
      ['duplicateProject', 2, 3],
      ['removeStaleCopies', 0, 1]
    ])
    expect(main.LINKED_MEDIA).toEqual(['screen.mp4', 'webcam.mp4', 'mic.m4a', 'system.m4a'])
    expect(main.COPYING_MARK).toBe('.copying')
  })

  it('renderer: the compositor and layers (P2), the editor parts (P3) and the copy menu and flow (P4)', async () => {
    expectExports(await load('../src/renderer/src/render/compositor'), [['viewSource', 2, 3]])
    expectExports(await load('../src/renderer/src/render/captionsLayer'), [['captionBlockAt', 5, 6]])
    expectExports(await load('../src/renderer/src/render/textOverlays'), [['drawKeystrokes', 6, 7]])
    expectExports(await load('../src/renderer/src/editor/panels/FollowSection'), [['FollowSection', 1, 1]])
    expectExports(await load('../src/renderer/src/editor/SafeZoneOverlay'), [['SafeZoneOverlay', 1, 1]])
    expectExports(await load('../src/renderer/src/editor/safeZonePref'), [
      ['safeZoneChoice', 0, 0],
      ['setSafeZoneChoice', 1, 1],
      ['useSafeZoneChoice', 0, 0]
    ])
    expectExports(await load('../src/renderer/src/editor/sceneRect'), [
      ['useSceneView', 5, 5],
      ['useSceneRect', 5, 5]
    ])
    expectExports(await load('../src/renderer/src/editor/CopyMenu'), [
      ['CopyMenu', 1, 1],
      ['CopyProgress', 1, 1]
    ])
    expectExports(await load('../src/renderer/src/editor/duplicateFlow'), [['runDuplicate', 2, 2]])
  })
})

/* ---------- the signatures, checked by the typecheck ---------- */

/** True when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
/** Compiles only for `true`: a signature that differs from the spec's fails npm run typecheck. */
const same = <T extends true>(): T => true as T

type Rect = layout.Rect
type ViewSize = layout.ViewSize
type SceneProject = layout.SceneProject
type Camera = zoom.Camera
type ZoomStyle = zoom.ZoomStyle
type MainCopy = typeof import('../src/main/projectCopy')

describe('the signatures of §9 (checked by the typecheck)', () => {
  it('P1 engine', () => {
    const checks = [
      same<Equal<typeof layout.baseView, (slot: Rect, vw: number, vh: number, level: number) => ViewSize>>(),
      same<Equal<typeof layout.virtualRect, (slot: Rect, base: ViewSize) => Rect>>(),
      same<Equal<typeof layout.intersectRect, (a: Rect, b: Rect) => Rect>>(),
      same<
        Equal<
          typeof layout.followGeometry,
          (layout: CameraLayout, project: SceneProject, outW: number, outH: number, vw: number, vh: number, corner?: Corner) => { slot: Rect; camera: layout.CameraBox; band: Rect | null }
        >
      >(),
      same<Equal<typeof layout.bandSide, (project: SceneProject, outW: number, outH: number, vw: number, vh: number) => 'top' | 'bottom' | null>>(),
      same<Equal<layout.SceneLayout, { screen: Rect; camera: layout.CameraBox | null; moving: boolean; follow?: layout.FollowGeometry }>>(),
      same<Equal<layout.FollowGeometry, { slot: Rect; base: ViewSize; band: Rect | null }>>(),
      same<Equal<SceneProject, Pick<Project, 'style' | 'layouts' | 'webcam' | 'hasWebcam'> & Partial<Pick<Project, 'clips' | 'duration' | 'reframe'>>>>(),
      same<Equal<zoom.PathLike, { at(t: number): { x: number; y: number } }>>(),
      same<Equal<zoom.ViewBase, { cx: number; cy: number; w: number; h: number }>>(),
      same<Equal<Parameters<typeof zoom.clampCamera>, [c: Camera, base?: Pick<zoom.ViewBase, 'w' | 'h'>]>>(),
      same<Equal<Parameters<typeof zoom.cameraFor>, [scale: number, fx: number, fy: number, base?: Pick<zoom.ViewBase, 'w' | 'h'>]>>(),
      same<Equal<Parameters<typeof zoom.blendCameras>, [a: Camera, b: Camera, w: number, base?: Pick<zoom.ViewBase, 'w' | 'h'>]>>(),
      same<Equal<Parameters<typeof zoom.cameraAt>, [zooms: ZoomSegment[], t: number, focusTrack: zoom.PathLike | null, style?: ZoomStyle, base?: zoom.ViewBase]>>(),
      same<Equal<Parameters<typeof zoom.zoomTargetScale>, [z: Pick<ZoomSegment, 'scale' | 'focus'>, floor?: number]>>(),
      same<Equal<typeof zoom.typingSessionsOf, (track: CursorTrack, settings: AutoZoomSettings) => { t0: number; t1: number; place: { x: number; y: number } }[]>>(),
      same<Equal<typeof reframe.glide, (u: number, r: number) => number>>(),
      same<Equal<typeof reframe.glideInverse, (p: number, r: number) => number>>(),
      same<Equal<Parameters<typeof reframe.panDuration>, [d: number, pace?: reframe.PaceParams]>>(),
      same<Equal<typeof reframe.followLimits, (project: reframe.FollowProject) => reframe.FollowLimits | null>>(),
      same<Equal<typeof reframe.framedZooms, (zooms: ZoomSegment[], limits: reframe.FollowLimits) => ZoomSegment[]>>(),
      same<
        Equal<
          typeof reframe.followAttention,
          (project: reframe.FollowProject, track: CursorTrack) => { o: Float64Array; x: Float32Array; y: Float32Array; kind: Uint8Array; event: Float64Array }
        >
      >(),
      same<Equal<typeof reframe.planFollow, (project: reframe.FollowProject, track: CursorTrack) => reframe.FollowPlan>>(),
      same<Equal<typeof reframe.followPlanFor, (project: reframe.FollowProject, track: CursorTrack) => reframe.FollowPlan>>(),
      same<Equal<Parameters<typeof reframe.followCentre>, [plan: reframe.FollowPlan, t: number, at?: number]>>(),
      same<
        Equal<
          reframe.FollowProject,
          Pick<Project, 'clips' | 'zooms' | 'layouts' | 'webcam' | 'hasWebcam' | 'style' | 'reframe' | 'width' | 'height' | 'zoomSettings' | 'duration' | 'shapes' | 'spotlights'>
        >
      >(),
      same<Equal<reframe.FollowLimits, { base: ViewSize; level: number; mag: number; fit: number; cap: number }>>(),
      same<Equal<typeof frameViewModule.drawnForFrame, (project: Project, w: number, h: number, vw: number, vh: number) => Project>>(),
      same<Equal<Parameters<typeof frameViewModule.frameCamera>, [scene: frameViewModule.ViewScene, layout: layout.SceneLayout, t: number, at?: number]>>(),
      same<
        Equal<
          Parameters<typeof frameViewModule.frameView>,
          [scene: frameViewModule.ViewScene, w: number, h: number, vw: number, vh: number, t: number, at?: number]
        >
      >(),
      same<Equal<ReturnType<typeof frameViewModule.frameView>, { project: Project; layout: layout.SceneLayout; cam: Camera }>>(),
      same<Equal<typeof frameViewModule.followGain, (layout: layout.SceneLayout, w: number, h: number, vw: number, vh: number, padding: number) => number>>(),
      same<Equal<typeof frameViewModule.narrowBoxZoom, (zoom: number, boxAspect: number) => number>>(),
      same<Equal<typeof frameViewModule.viewMagnification, (project: Project, outW: number, outH: number, vw: number, vh: number) => { rest: number; zoomed: number } | null>>(),
      same<Equal<frameViewModule.ViewScene, { project: Project; cursor: CursorTrack; focusPath: zoom.PathLike }>>(),
      same<Equal<typeof reframeData.readReframe, (raw: unknown) => ReframeSettings | undefined>>(),
      same<Equal<typeof reframeData.readCopyOf, (raw: unknown) => ProjectCopyOf | undefined>>()
    ]
    expect(checks.every(Boolean)).toBe(true)
  })

  it('P2 placement', () => {
    type Area = Rect | null
    const checks = [
      same<Equal<Parameters<typeof captionLayoutModule.captionMetrics>, [settings: Pick<CaptionSettings, 'size' | 'preset' | 'background'>, w: number, h: number, area?: Area]>>(),
      same<
        Equal<
          Parameters<typeof captionLayoutModule.captionLayout>,
          [
            seg: Pick<CaptionSegment, 'start' | 'end' | 'text' | 'words'>,
            settings: Pick<CaptionSettings, 'size' | 'preset' | 'background' | 'maxLines'>,
            w: number,
            h: number,
            measure: captionLayoutModule.MeasureText,
            area?: Area
          ]
        >
      >(),
      same<Equal<Parameters<typeof captionLayoutModule.placeChunk>, [layout: captionLayoutModule.CaptionLayout, chunk: captionLayoutModule.CaptionChunk, position: CaptionSettings['position'], w: number, h: number, area?: Area]>>(),
      same<Equal<Parameters<typeof watermark.watermarkRect>, [w: number, h: number, wm: Pick<WatermarkSettings, 'kind' | 'size' | 'position' | 'margin'>, aspect: number, area?: Area]>>(),
      same<Equal<Parameters<typeof titleCards.titleLayout>, [card: Pick<TitleCard, 'title' | 'subtitle' | 'style'>, w: number, h: number, measure: titleCards.MeasureText, area?: Area]>>(),
      same<Equal<Parameters<typeof overlays.cameraDisplacement>, [a: Camera, b: Camera, rect: overlays.RectLike, clip?: overlays.RectLike]>>(),
      same<Equal<typeof safeZones.zonesFor, (choice: safeZones.SafeChoice) => safeZones.SafeBox[]>>(),
      same<Equal<typeof safeZones.textArea, (project: Project, w: number, h: number, vw: number, vh: number, t: number) => Rect | null>>(),
      same<Equal<Parameters<typeof safeZones.keepInArea>, [box: Rect, area: Rect, minScale?: number]>>(),
      same<Equal<ReturnType<typeof safeZones.keepInArea>, { dx: number; dy: number; scale: number }>>()
    ]
    expect(checks.every(Boolean)).toBe(true)
  })

  it('P3 and P4', () => {
    const checks = [
      same<
        Equal<
          typeof followEdit.holdViewAt,
          (project: Project, t: number, centre: { x: number; y: number }, crop: NormRect | null) => { project: Project; zoomId: string } | { project: null; reason: 'no-room' }
        >
      >(),
      same<Equal<typeof followEdit.dragView, (project: Project, t: number, delta: { x: number; y: number }, crop: NormRect | null, noData: boolean) => Project>>(),
      same<Equal<typeof followEdit.followStatus, (project: Project, cursorValid: boolean, vw: number, vh: number) => 'off' | 'following' | 'no-input' | 'unavailable'>>(),
      same<Equal<duplicate.CopyKind, 'copy' | 'vertical' | 'square'>>(),
      same<Equal<duplicate.MeasureText, (text: string, px: number, font: string, weight: number) => number>>(),
      same<Equal<typeof duplicate.copyName, (name: string, kind: duplicate.CopyKind) => string>>(),
      same<Equal<typeof duplicate.canCopyAs, (project: Project, kind: duplicate.CopyKind, vw: number, vh: number) => { ok: true } | { ok: false; reason: string }>>(),
      same<Equal<typeof duplicate.projectCopy, (project: Project, kind: duplicate.CopyKind, measure: duplicate.MeasureText | null) => Project>>(),
      same<
        Equal<
          typeof duplicate.refitItems,
          (project: Pick<Project, 'annotations' | 'overlays'>, w: number, h: number, area: Rect, measure: duplicate.MeasureText | null) => Pick<Project, 'annotations' | 'overlays'>
        >
      >(),
      same<Equal<MainCopy['copiedFile'], (name: string) => 'link' | 'copy' | null>>(),
      same<Equal<Parameters<MainCopy['linkAllowed']>, [root: string, env?: NodeJS.ProcessEnv]>>(),
      same<
        Equal<
          Parameters<MainCopy['duplicateProject']>,
          [sourceId: string, raw: unknown, opts?: { signal?: AbortSignal; onProgress?: (p: DuplicateProgress) => void; now?: Date }]
        >
      >(),
      same<Equal<ReturnType<MainCopy['duplicateProject']>, Promise<DuplicateResult>>>(),
      same<Equal<Parameters<MainCopy['removeStaleCopies']>, [now?: number]>>(),
      same<Equal<ProjectsApi['duplicateProject'], (sourceId: string, copy: Project) => Promise<DuplicateResult>>>(),
      same<Equal<ProjectsApi['onDuplicateProgress'], (listener: (p: DuplicateProgress) => void) => () => void>>(),
      same<Equal<ProjectsApi['cancelDuplicate'], () => void>>(),
      same<Equal<DuplicateProgress, { done: number; total: number }>>(),
      same<Equal<DuplicateResult, { id: string; name: string; linked: boolean }>>()
    ]
    expect(checks.every(Boolean)).toBe(true)
  })
})

/* ---------- frozen data ---------- */

describe('frozen data', () => {
  it('the Movement presets are the columns of §5.18', () => {
    const shared = {
      grid: 1 / 30,
      visible: 0.45,
      inView: 0.35,
      lookAhead: 1.2,
      startAhead: 2,
      minChange: 0.1,
      clickBefore: 0.4,
      clickAfter: 0.6,
      typingTail: 0.3,
      scrollTail: 0.3,
      maxAimedMove: 2.5,
      trackAhead: 0.3,
      minPan: 0.5,
      maxPan: 1.5,
      hardSpeed: 3,
      minShown: 0.3,
      settle: 0.1,
      joinGap: 0.6,
      glideRamp: 0.5
    }
    expect(reframe.FOLLOW).toEqual(shared)
    expect(reframe.PACE.calm).toEqual({ ...shared, deadZone: 0.35, confirm: 0.7, minHold: 1.2, maxSpeed: 1.2, maxAccel: 4, maxLead: 0.5 })
    expect(reframe.PACE.balanced).toEqual({ ...shared, deadZone: 0.3, confirm: 0.5, minHold: 0.8, maxSpeed: 1.5, maxAccel: 5, maxLead: 0.6 })
    expect(reframe.PACE.lively).toEqual({ ...shared, deadZone: 0.25, confirm: 0.35, minHold: 0.5, maxSpeed: 2, maxAccel: 6, maxLead: 0.8 })
    expect(Object.keys(reframe.PACE)).toEqual(['calm', 'balanced', 'lively'])
    expect(Object.isFrozen(reframe.PACE) && Object.isFrozen(reframe.PACE.balanced)).toBe(true)
    expect(reframe.ZOOM_STRENGTH).toBe(0.5)
    expect(reframe.MAX_MAGNIFY).toBe(3)
    expect(reframe.ATTENTION_KINDS).toEqual(['none', 'zoom', 'typing', 'click', 'shape', 'scroll', 'cursor'])
  })

  it('the safe-zone table and the common safe area of §7', () => {
    const box = (b: safeZones.SafeBox): [number, number, number, number, string] => [b.x, b.y, b.w, b.h, b.label]
    expect(Object.keys(safeZones.SAFE_ZONES)).toEqual(['tiktok', 'reels', 'shorts'])
    expect(safeZones.SAFE_ZONES.tiktok.name).toBe('TikTok')
    expect(safeZones.SAFE_ZONES.reels.name).toBe('Instagram Reels')
    expect(safeZones.SAFE_ZONES.shorts.name).toBe('YouTube Shorts')
    expect(safeZones.SAFE_ZONES.tiktok.boxes.map(box)).toEqual([
      [0, 0, 1, 0.08, 'Tabs and search'],
      [0.86, 0.38, 0.14, 0.42, 'Like, comment, share'],
      [0, 0.78, 1, 0.22, 'Name, caption and sound']
    ])
    expect(safeZones.SAFE_ZONES.reels.boxes.map(box)).toEqual([
      [0, 0, 1, 0.11, 'Reels and camera'],
      [0.87, 0.45, 0.13, 0.37, 'Like, comment, share'],
      [0, 0.78, 1, 0.22, 'Name, caption and audio']
    ])
    expect(safeZones.SAFE_ZONES.shorts.boxes.map(box)).toEqual([
      [0, 0, 1, 0.08, 'Search and menu'],
      [0.86, 0.4, 0.14, 0.44, 'Like, comment, share, remix'],
      [0, 0.79, 1, 0.21, 'Title, channel and subscribe']
    ])
    for (const p of Object.values(safeZones.SAFE_ZONES)) expect(p.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(safeZones.COMMON_SAFE).toEqual({ x: 0.06, y: 0.11, w: 0.8, h: 0.65 })
    expect(Object.isFrozen(safeZones.SAFE_ZONES) && Object.isFrozen(safeZones.COMMON_SAFE) && Object.isFrozen(safeZones.SAFE_ZONES.reels.boxes)).toBe(true)
  })
})

/* ---------- the six commands, R and G ---------- */

describe('the commands of §2.11', () => {
  const NEW: [CommandId, string, string, boolean, string[]][] = [
    ['makeVertical', 'Make a vertical version', 'General', false, []],
    ['makeSquare', 'Make a square version', 'General', false, []],
    ['duplicateVideo', 'Duplicate this video', 'General', false, []],
    ['toggleFollow', 'Follow the action', 'Zoom', true, []],
    ['holdView', 'Hold the view here', 'Zoom', false, ['R']],
    ['toggleSafeZones', 'Show safe zones', 'General', true, ['G']]
  ]

  it('are in the palette with their titles, categories, toggles and keys', () => {
    const palette = PALETTE_COMMANDS.map((c) => c.id)
    for (const [id, title, category, toggle, keys] of NEW) {
      expect(COMMAND_IDS, id).toContain(id)
      expect(palette, id).toContain(id)
      expect(commandInfo(id).title, id).toBe(title)
      expect(commandInfo(id).category, id).toBe(category)
      expect(!!commandInfo(id).toggle, id).toBe(toggle)
      expect(DEFAULT_KEYMAP[id], id).toEqual(keys)
    }
  })

  it('R and G are free: not reserved, and no other command has them', () => {
    expect(reservedReason('R')).toBeNull()
    expect(reservedReason('G')).toBeNull()
    expect(checkShortcut('R', 'holdView')).toEqual({ ok: true, accelerator: 'R' })
    expect(checkShortcut('G', 'toggleSafeZones')).toEqual({ ok: true, accelerator: 'G' })
    expect([...findConflicts(DEFAULT_KEYMAP).keys()]).toEqual([])
    const owners = (key: string): string[] => Object.entries(DEFAULT_KEYMAP).filter(([, b]) => b.includes(key)).map(([id]) => id)
    expect(owners('R')).toEqual(['holdView'])
    expect(owners('G')).toEqual(['toggleSafeZones'])
  })
})
