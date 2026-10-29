import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { displayTime } from '../../../../shared/editor/clips'
import { followStatus, withAppSafe, withFollowing } from '../../../../shared/editor/followEdit'
import { withShortcut } from '../../../../shared/editor/shortcuts'
import { cropOf, cropProject, fromCrop, toCrop, zoomFromView, zoomInView } from '../../../../shared/engine/crop'
import { frameOf } from '../../../../shared/engine/deviceFrames'
import { layoutsApply, outputSize } from '../../../../shared/engine/layout'
import { clamp } from '../../../../shared/engine/math'
import { followLimits } from '../../../../shared/engine/reframe'
import { canFollow, DEFAULT_REFRAME, isTall, REFRAME_LIMITS, withReframe } from '../../../../shared/engine/reframeData'
import { tiltOf } from '../../../../shared/engine/tilt'
import { zoomAt } from '../../../../shared/engine/zoom'
import type { Project, ReframeCamera, ReframePace, ReframeSettings } from '../../../../shared/types'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { useGroup } from '../groupContext'
import { useKeymap } from '../keymapContext'

/**
 * What the section reads from the editor besides the project (Editor.tsx provides it): whether
 * the recording has cursor data, and a counter that scrolls the section into view when it changes
 * (the copy made by Make a vertical version opens here).
 */
export interface FollowEnv {
  cursorValid: boolean
  reveal: number
}

export const FollowEnvContext = createContext<FollowEnv>({ cursorValid: true, reveal: 0 })

const PACES: { value: ReframePace; label: string; title: string }[] = [
  { value: 'calm', label: 'Calm', title: 'Moves less, and more slowly' },
  { value: 'balanced', label: 'Balanced', title: 'Follows each new place you work in' },
  { value: 'lively', label: 'Lively', title: 'Reacts sooner and moves faster' }
]

const CAMERAS: { value: ReframeCamera; label: string; title: string }[] = [
  { value: 'top', label: 'Band on top', title: 'Your camera above the screen' },
  { value: 'bottom', label: 'Band at the bottom', title: 'Your camera under the screen' },
  { value: 'bubble', label: 'Bubble', title: 'Your camera bubble over the screen, as in the Camera tab' }
]

/** Settings shown before any are stored: following off, text placed as before. */
const UNSET: ReframeSettings = { ...DEFAULT_REFRAME, mode: 'fit', appSafe: false }
/** A view shorter than the recording by more than rounding. */
const SHORTER = 1 - 1e-6

const levelFmt = (v: number): string => `${Number(v.toFixed(2))}×`

/**
 * Style › Vertical framing (docs/design/vertical-video.md §2.5): Follow the action, how close,
 * Movement, the camera band, where the view rests, Hold the view here and Keep text clear of app
 * buttons; or, in a frame that cannot follow while a 9:16 one could, the "Making a Short?" callout
 * (nothing when neither can: a tall recording). vw × vh: the recording as cropped. Every change is
 * one undo step (one per slider gesture).
 */
export function FollowSection(props: { project: Project; vw: number; vh: number; onMakeVertical(): void }): JSX.Element {
  const { project, vw, vh, onMakeVertical } = props
  const { store, player } = useEditor()
  const { cursorValid, reveal } = useContext(FollowEnvContext)
  const group = useGroup()
  const keymap = useKeymap()
  const boxRef = useRef<HTMLDivElement>(null)

  const status = followStatus(project, cursorValid, vw, vh)
  const following = status === 'following' || status === 'no-input'
  // The view's limits at the canonical frame, measured on the project as drawn (cropped).
  const drawn = useMemo(() => cropProject(project), [project])
  const limits = useMemo(() => (following ? followLimits(drawn) : null), [following, drawn])

  // The zoom at the playhead while it has a fixed point (View at the playhead edits it). Re-renders
  // only when that zoom changes, not on every frame.
  const zoomId = useSyncExternalStore(player.subscribe, () => {
    const z = following ? zoomAt(project.zooms, displayTime(project.clips, player.time)) : null
    return z?.focus.mode === 'fixed' ? z.id : ''
  })

  useEffect(() => {
    if (reveal) boxRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [reveal])

  if (status === 'unavailable') {
    if (!canFollow('9:16', vw, vh)) return <></>
    return (
      <div data-testid="framing-section" ref={boxRef}>
        <Section title="Vertical framing">
          <div className="framing-callout" data-testid="vertical-callout">
            <span>Making a Short?</span>
            <button className="btn small" onClick={onMakeVertical}>
              Make a vertical version
            </button>
          </div>
        </Section>
      </div>
    )
  }

  const frame = outputSize(project.style.aspectRatio, vw, vh, 1080)
  const tall = isTall(frame.width, frame.height)
  const reframe = project.reframe ?? UNSET
  const crop = cropOf(project)
  const cameraShown = layoutsApply(project)
  const set = (patch: Partial<ReframeSettings>, key?: string): void => store.update((p) => withReframe(p, patch), key)

  // Where the view rests, in the view (after the crop, kept inside it as the drawn project keeps it):
  // the centre of what is shown when unset.
  const restOf = (p: Project): { x: number; y: number } => {
    const r = toCrop(crop, p.reframe?.rest ?? fromCrop(crop, { x: 0.5, y: 0.5 }))
    return { x: clamp(r.x, 0, 1), y: clamp(r.y, 0, 1) }
  }
  const rest = restOf(project)
  const setRest = (axis: 'x' | 'y', v: number): void => store.update((p) => withReframe(p, { rest: fromCrop(crop, { ...restOf(p), [axis]: v }) }), `reframe.rest.${axis}`)

  // The fixed point of the zoom at the playhead, in the view.
  const viewZoom = zoomId ? project.zooms.find((z) => z.id === zoomId) : undefined
  const point = viewZoom ? zoomInView(crop, viewZoom).focus : null
  const setPoint = (axis: 'x' | 'y', v: number): void => {
    const id = zoomId
    store.update(
      (p) => ({
        ...p,
        zooms: p.zooms.map((z) => {
          const view = z.id === id ? zoomInView(crop, z) : null
          return view?.focus.mode === 'fixed' ? zoomFromView(crop, { ...view, focus: { ...view.focus, [axis]: v }, auto: false }) : z
        })
      }),
      `zoom-focus:${id}`
    )
  }

  const limited = !!limits && limits.level < reframe.level - 1e-6
  const shorter = !!limits && limits.base.h < SHORTER
  const tiltOrFrame = !!frameOf(project.style) || !!tiltOf(project)

  return (
    <div data-testid="framing-section" ref={boxRef}>
      <Section title="Vertical framing">
        <div data-testid="follow-toggle">
          <Toggle label="Follow the action" checked={following} onChange={(on) => store.update((p) => withFollowing(p, on, vw, vh))} />
        </div>
        {!following && <p className="hint">Your whole screen is shrunk to fit this shape. Turn this on to crop in and follow your cursor, clicks and typing.</p>}
        {following && (
          <>
            <p className="hint" data-testid="follow-status" data-state={status}>
              {status === 'following' ? 'Following your cursor, clicks and typing.' : 'This recording has no cursor data, so the view stays where you put it.'}
            </p>
            <div data-testid="follow-level">
              <Slider label="How close" value={reframe.level} {...REFRAME_LIMITS.level} format={levelFmt} onChange={(v) => set({ level: v }, 'reframe.level')} />
            </div>
            {limited && <p className="hint">Limited to keep the picture sharp.</p>}
            <div className="field-block" data-testid="follow-pace">
              <span className="field-label">Movement</span>
              <Chips label="Movement" value={reframe.pace} options={PACES} onChange={(pace) => set({ pace })} />
            </div>
            {tall && cameraShown && (
              <div className="field-block" data-testid="follow-camera">
                <span className="field-label">Camera</span>
                <Chips label="Camera" value={reframe.camera} options={CAMERAS} onChange={(camera) => set({ camera })} />
                {reframe.camera === 'bottom' && <p className="hint">The apps put their captions over the bottom of the video, so a band on top usually stays clearer.</p>}
              </div>
            )}
            {tall && cameraShown && reframe.camera !== 'bubble' && (
              <div data-testid="follow-band">
                <Slider label="Camera size" value={reframe.band} {...REFRAME_LIMITS.band} format={pctFmt} onChange={(v) => set({ band: v }, 'reframe.band')} />
              </div>
            )}
            {!tall && cameraShown && <p className="hint">Square videos keep the camera bubble.</p>}
            {status === 'no-input' && (
              <div className="field-block" role="group" aria-label="Where the view rests">
                <span className="field-label">Where the view rests</span>
                <div data-testid="follow-rest-x">
                  <Slider label="Left to right" value={rest.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setRest('x', v)} />
                </div>
                {shorter && (
                  <div data-testid="follow-rest-y">
                    <Slider label="Top to bottom" value={rest.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setRest('y', v)} />
                  </div>
                )}
              </div>
            )}
            <div className="field-block">
              <button className="btn small" data-testid="follow-hold" onClick={() => group.command('holdView')} title={withShortcut('Hold the view here', keymap.holdView)}>
                Hold the view here
              </button>
              <p className="hint">Drag the picture to aim the view. Zooms still work inside it.</p>
            </div>
            {point?.mode === 'fixed' && (
              <div className="field-block" role="group" aria-label="View at the playhead">
                <span className="field-label">View at the playhead</span>
                <div data-testid="follow-view-x">
                  <Slider label="Left to right" value={point.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setPoint('x', v)} />
                </div>
                <div data-testid="follow-view-y">
                  <Slider label="Top to bottom" value={point.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setPoint('y', v)} />
                </div>
              </div>
            )}
          </>
        )}
        {tall && (
          <>
            <div data-testid="app-safe-toggle">
              <Toggle label="Keep text clear of app buttons" checked={reframe.appSafe} onChange={(on) => store.update((p) => withAppSafe(p, on))} />
            </div>
            <p className="hint">Places captions, key presses, your logo and lower-third titles where TikTok, Reels and Shorts don't put buttons.</p>
          </>
        )}
        {following && tiltOrFrame && <p className="hint">The 3D tilt and the device frame are left out while the view follows the action.</p>}
        {status === 'following' && <p className="hint">A stray click pulled the view away? Ignore the click (Zoom › Selected click) and the view stays put.</p>}
      </Section>
    </div>
  )
}
