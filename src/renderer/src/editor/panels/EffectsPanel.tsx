import { useMemo } from 'react'
import { followsAction } from '../../../../shared/editor/followEdit'
import { LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import { sameAngles, TILT_LIMITS, TILT_PRESETS, tiltCss, tiltSettingsOf, type TiltAnimation } from '../../../../shared/engine/tilt'
import type { CursorTrack, Project, TiltSettings } from '../../../../shared/types'
import { tiltSupported } from '../../render/tiltLayer'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { IMPORTED_COPY, isImported } from '../../../../shared/import/imported'
import './tiltPanel.css'

const L = LOOK_LIMITS

/* ---------- Effects ---------- */

export function EffectsPanel({ project, cursor }: { project: Project; cursor: CursorTrack }): JSX.Element {
  const { store } = useEditor()
  const { effects } = project
  const keys = cursor.keys?.length ?? 0
  const setKeys = (patch: Partial<Project['effects']['keystrokes']>, key?: string): void =>
    store.update((p) => ({ ...p, effects: { ...p.effects, keystrokes: { ...p.effects.keystrokes, ...patch } } }), key)
  return (
    <>
      <TiltSection project={project} cursor={cursor} />
      <Section title="Motion blur">
        <Slider
          label="Strength"
          value={effects.motionBlur}
          {...L.motionBlur}
          step={0.05}
          format={(v) => (v === 0 ? 'Off' : pctFmt(v))}
          onChange={(v) => store.update((p) => ({ ...p, effects: { ...p.effects, motionBlur: v } }), 'effects.motionBlur')}
        />
        <p className="hint">Blurs fast zoom and pan movements, like a real camera.</p>
      </Section>
      <Section title="Keyboard shortcuts">
        <p className="hint">
          {keys > 0 ? `${keys} shortcut${keys === 1 ? '' : 's'} recorded (plain typing is never recorded).` : isImported(project) ? IMPORTED_COPY.keystrokes : 'No keyboard shortcuts were recorded in this video.'}
        </p>
        <Toggle label="Show shortcuts on screen" checked={effects.keystrokes.show} onChange={(v) => setKeys({ show: v })} />
        <Chips
          label="Shortcut position"
          value={effects.keystrokes.position}
          disabled={!effects.keystrokes.show}
          onChange={(position) => setKeys({ position })}
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'top', label: 'Top' }
          ]}
        />
        <Slider label="Size" value={effects.keystrokes.size} {...L.keystrokeSize} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} disabled={!effects.keystrokes.show} onChange={(v) => setKeys({ size: v }, 'effects.keys.size')} />
      </Section>
    </>
  )
}

/* ---------- 3D tilt ---------- */

/** Size (px) of the mini card on a preset tile; its perspective is scaled to it like the video's. */
const TILE_CARD = 30

const MOVEMENT: Record<TiltAnimation, string> = {
  none: 'The card keeps these angles for the whole video.',
  cursor: 'The card leans a little toward the cursor as it moves, so the part you work on comes forward.',
  zoom: 'The card straightens up while the camera zooms in, so zoomed-in details stay easy to read.'
}
const NO_CURSOR = 'This recording has no cursor positions to follow'

const degrees = (v: number): number => Math.round(Math.abs(v))

/** The recording card as a 3D-tilted plane over the background, like a product shot. */
function TiltSection({ project, cursor }: { project: Project; cursor: CursorTrack }): JSX.Element {
  const { store } = useEditor()
  const tilt = tiltSettingsOf(project)
  const on = tilt.enabled
  // Asked once per panel: without WebGL the tilt is drawn flat (the compositor says so too).
  const supported = useMemo(() => tiltSupported(), [])
  const set = (patch: Partial<TiltSettings>, key?: string): void => store.update((p) => ({ ...p, tilt: { ...tiltSettingsOf(p), ...patch } }), key)
  // Following the cursor (from a preset or a saved default) without one to follow: the card stands still.
  const noCursor = tilt.animate === 'cursor' && !cursor.valid
  const movement: TiltAnimation = noCursor ? 'none' : tilt.animate
  const A = TILT_LIMITS.angle
  return (
    <Section title="3D tilt">
      <Toggle label="Tilt the recording in 3D" checked={on} onChange={(v) => set({ enabled: v })} />
      {followsAction(project) && <p className="hint">The 3D tilt is not drawn while the view follows the action.</p>}
      <div className="tilt-presets" role="group" aria-label="Tilt presets">
        {TILT_PRESETS.map((preset) => {
          const active = on && sameAngles(tilt, preset.angles)
          return (
            <button
              key={preset.id}
              className={`tilt-preset ${active ? 'active' : ''}`}
              aria-pressed={active}
              aria-label={`${preset.label} tilt`}
              title={`${preset.title}${on ? '' : ' (turns the tilt on)'}`}
              data-tilt-preset={preset.id}
              onClick={() => set({ ...preset.angles, enabled: true })}
            >
              <span className="tilt-preset-stage" aria-hidden="true">
                <span className="tilt-preset-card" style={{ transform: tiltCss(preset.angles, TILE_CARD) }} />
              </span>
              {preset.label}
            </button>
          )
        })}
      </div>
      <Slider
        label="Tilt back"
        value={tilt.rotateX}
        min={A.min}
        max={A.max}
        step={1}
        disabled={!on}
        format={(v) => (degrees(v) === 0 ? 'Level' : `${degrees(v)}° ${v > 0 ? 'back' : 'forward'}`)}
        onChange={(v) => set({ rotateX: v }, 'tilt.rotateX')}
      />
      <Slider
        label="Turn"
        value={tilt.rotateY}
        min={A.min}
        max={A.max}
        step={1}
        disabled={!on}
        format={(v) => (degrees(v) === 0 ? 'Straight' : `${degrees(v)}° ${v > 0 ? 'right' : 'left'}`)}
        onChange={(v) => set({ rotateY: v }, 'tilt.rotateY')}
      />
      <Slider
        label="Perspective"
        value={tilt.perspective}
        {...TILT_LIMITS.perspective}
        step={0.05}
        disabled={!on}
        format={(v) => (v === 0 ? 'None' : pctFmt(v))}
        onChange={(v) => set({ perspective: v }, 'tilt.perspective')}
      />
      <Chips
        label="Tilt movement"
        value={movement}
        disabled={!on}
        onChange={(animate) => set({ animate })}
        options={[
          { value: 'none', label: 'Still', title: MOVEMENT.none },
          {
            value: 'cursor',
            label: 'Follow cursor',
            title: cursor.valid ? MOVEMENT.cursor : NO_CURSOR,
            disabled: !cursor.valid
          },
          { value: 'zoom', label: 'Flatten on zoom', title: MOVEMENT.zoom }
        ]}
      />
      <p className="hint" data-testid="tilt-movement">{noCursor ? `${NO_CURSOR}, so the card keeps these angles.` : MOVEMENT[movement]}</p>
      {!supported && (
        <p className="hint tilt-warn" data-testid="tilt-unsupported">
          3D tilt needs WebGL, which this computer's graphics driver does not provide: the video is shown and exported flat.
        </p>
      )}
      <p className="hint">While a shape or spotlight is edited on the preview, or a zoom's focus is picked, the preview shows the card flat so the handles line up with the video.</p>
    </Section>
  )
}
