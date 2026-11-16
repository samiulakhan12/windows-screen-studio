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
import { t } from '../../../../shared/i18n/t'

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

const PACES = (): { value: ReframePace; label: string; title: string }[] => [
  { value: 'calm', label: t('style.followSection.pace.calm'), title: t('style.followSection.pace.calm.title') },
  { value: 'balanced', label: t('style.followSection.pace.balanced'), title: t('style.followSection.pace.balanced.title') },
  { value: 'lively', label: t('style.followSection.pace.lively'), title: t('style.followSection.pace.lively.title') }
]

const CAMERAS = (): { value: ReframeCamera; label: string; title: string }[] => [
  { value: 'top', label: t('style.followSection.camera.top'), title: t('style.followSection.camera.top.title') },
  { value: 'bottom', label: t('style.followSection.camera.bottom'), title: t('style.followSection.camera.bottom.title') },
  { value: 'bubble', label: t('style.followSection.camera.bubble'), title: t('style.followSection.camera.bubble.title') }
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
        <Section title={t('style.followSection.verticalFraming')}>
          <div className="framing-callout" data-testid="vertical-callout">
            <span>{t('style.followSection.makingAShort')}</span>
            <button className="btn small" onClick={onMakeVertical}>{t('style.followSection.makeAVerticalVersion')}</button>
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
      <Section title={t('style.followSection.verticalFraming')}>
        <div data-testid="follow-toggle">
          <Toggle label={t('style.followSection.followTheAction')} checked={following} onChange={(on) => store.update((p) => withFollowing(p, on, vw, vh))} />
        </div>
        {!following && <p className="hint">{t('style.followSection.yourWholeScreenIs')}</p>}
        {following && (
          <>
            <p className="hint" data-testid="follow-status" data-state={status}>
              {status === 'following' ? t('style.followSection.followingYourCursorClicks') : t('style.followSection.thisRecordingHasNo')}
            </p>
            <div data-testid="follow-level">
              <Slider label={t('style.followSection.howClose')} value={reframe.level} {...REFRAME_LIMITS.level} format={levelFmt} onChange={(v) => set({ level: v }, 'reframe.level')} />
            </div>
            {limited && <p className="hint">{t('style.followSection.limitedToKeepThe')}</p>}
            <div className="field-block" data-testid="follow-pace">
              <span className="field-label">{t('style.followSection.movement')}</span>
              <Chips label={t('style.followSection.movement')} value={reframe.pace} options={PACES()} onChange={(pace) => set({ pace })} />
            </div>
            {tall && cameraShown && (
              <div className="field-block" data-testid="follow-camera">
                <span className="field-label">{t('common.label.camera')}</span>
                <Chips label={t('common.label.camera')} value={reframe.camera} options={CAMERAS()} onChange={(camera) => set({ camera })} />
                {reframe.camera === 'bottom' && <p className="hint">{t('style.followSection.theAppsPutTheir')}</p>}
              </div>
            )}
            {tall && cameraShown && reframe.camera !== 'bubble' && (
              <div data-testid="follow-band">
                <Slider label={t('style.followSection.cameraSize')} value={reframe.band} {...REFRAME_LIMITS.band} format={pctFmt} onChange={(v) => set({ band: v }, 'reframe.band')} />
              </div>
            )}
            {!tall && cameraShown && <p className="hint">{t('style.followSection.squareVideosKeepThe')}</p>}
            {status === 'no-input' && (
              <div className="field-block" role="group" aria-label={t('style.followSection.whereTheViewRests')}>
                <span className="field-label">{t('style.followSection.whereTheViewRests')}</span>
                <div data-testid="follow-rest-x">
                  <Slider label={t('style.followSection.leftToRight')} value={rest.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setRest('x', v)} />
                </div>
                {shorter && (
                  <div data-testid="follow-rest-y">
                    <Slider label={t('style.followSection.topToBottom')} value={rest.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setRest('y', v)} />
                  </div>
                )}
              </div>
            )}
            <div className="field-block">
              <button className="btn small" data-testid="follow-hold" onClick={() => group.command('holdView')} title={withShortcut(t('style.followSection.holdTitle'), keymap.holdView)}>{t('style.followSection.holdTheViewHere')}</button>
              <p className="hint">{t('style.followSection.dragThePictureTo')}</p>
            </div>
            {point?.mode === 'fixed' && (
              <div className="field-block" role="group" aria-label={t('style.followSection.viewAtThePlayhead')}>
                <span className="field-label">{t('style.followSection.viewAtThePlayhead')}</span>
                <div data-testid="follow-view-x">
                  <Slider label={t('style.followSection.leftToRight')} value={point.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setPoint('x', v)} />
                </div>
                <div data-testid="follow-view-y">
                  <Slider label={t('style.followSection.topToBottom')} value={point.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setPoint('y', v)} />
                </div>
              </div>
            )}
          </>
        )}
        {tall && (
          <>
            <div data-testid="app-safe-toggle">
              <Toggle label={t('style.followSection.keepTextClearOf')} checked={reframe.appSafe} onChange={(on) => store.update((p) => withAppSafe(p, on))} />
            </div>
            <p className="hint">{t('style.followSection.placesCaptionsPopUps')}</p>
          </>
        )}
        {following && tiltOrFrame && <p className="hint">{t('style.followSection.the3dTiltAnd')}</p>}
        {status === 'following' && <p className="hint">{t('style.followSection.aStrayClickPulled')}</p>}
      </Section>
    </div>
  )
}
