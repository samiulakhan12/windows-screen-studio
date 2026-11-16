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
import { ScreenColourSection } from './ScreenColourSection'
import { CalmMotionRow } from './CalmMotionRow'
import { ProgressBarLink } from './ProgressBarLink'
import { t } from '../../../../shared/i18n/t'
import { fmt } from '../../../../shared/i18n/fmt'

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
      {/* Editing polish (docs/design/editing-polish.md §2.4, §2.5, §7.5): the screen's colour, Calm motion and the progress bar's row. */}
      <ScreenColourSection project={project} />
      <TiltSection project={project} cursor={cursor} />
      <Section title={t('style.effectsPanel.motionBlur')}>
        <Slider
          label={t('common.label.strength')}
          value={effects.motionBlur}
          {...L.motionBlur}
          step={0.05}
          format={(v) => (v === 0 ? t('style.effectsPanel.motionBlurOff') : pctFmt(v))}
          onChange={(v) => store.update((p) => ({ ...p, effects: { ...p.effects, motionBlur: v } }), 'effects.motionBlur')}
        />
        <p className="hint">{t('style.effectsPanel.blursFastZoomAnd')}</p>
      </Section>
      <Section title={t('style.effectsPanel.keyboardShortcuts')}>
        <p className="hint">
          {keys > 0 ? t('style.effectsPanel.shortcutsRecorded', { count: keys, n: fmt.count(keys) }) : isImported(project) ? IMPORTED_COPY.keystrokes : t('style.effectsPanel.noKeyboardShortcutsWere')}
        </p>
        <Toggle label={t('style.effectsPanel.showShortcutsOnScreen')} checked={effects.keystrokes.show} onChange={(v) => setKeys({ show: v })} />
        <Chips
          label={t('style.effectsPanel.shortcutPosition')}
          value={effects.keystrokes.position}
          disabled={!effects.keystrokes.show}
          onChange={(position) => setKeys({ position })}
          options={[
            { value: 'bottom', label: t('style.effectsPanel.position.bottom') },
            { value: 'top', label: t('style.effectsPanel.position.top') }
          ]}
        />
        <Slider label={t('common.label.size')} value={effects.keystrokes.size} {...L.keystrokeSize} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} disabled={!effects.keystrokes.show} onChange={(v) => setKeys({ size: v }, 'effects.keys.size')} />
      </Section>
      <CalmMotionRow project={project} />
      <ProgressBarLink />
    </>
  )
}

/* ---------- 3D tilt ---------- */

/** Size (px) of the mini card on a preset tile; its perspective is scaled to it like the video's. */
const TILE_CARD = 30

const MOVEMENT = (): Record<TiltAnimation, string> => ({
  none: t('style.effectsPanel.movement.none'),
  cursor: t('style.effectsPanel.movement.cursor'),
  zoom: t('style.effectsPanel.movement.zoom')
})

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
    <Section title={t('style.effectsPanel.tiltTitle')}>
      <Toggle label={t('style.effectsPanel.tiltTheRecordingIn')} checked={on} onChange={(v) => set({ enabled: v })} />
      {followsAction(project) && <p className="hint">{t('style.effectsPanel.the3dTiltIs')}</p>}
      <div className="tilt-presets" role="group" aria-label={t('style.effectsPanel.tiltPresets')}>
        {TILT_PRESETS.map((preset) => {
          const active = on && sameAngles(tilt, preset.angles)
          return (
            <button
              key={preset.id}
              className={`tilt-preset ${active ? 'active' : ''}`}
              aria-pressed={active}
              aria-label={t('style.effectsPanel.tilt', { label: preset.label })}
              title={on ? preset.title : t('style.effectsPanel.presetTurnsOn', { title: preset.title })}
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
        label={t('style.effectsPanel.tiltBack')}
        value={tilt.rotateX}
        min={A.min}
        max={A.max}
        step={1}
        disabled={!on}
        format={(v) => (degrees(v) === 0 ? t('style.effectsPanel.angle.level') : v > 0 ? t('style.effectsPanel.angle.back', { n: fmt.count(degrees(v)) }) : t('style.effectsPanel.angle.forward', { n: fmt.count(degrees(v)) }))}
        onChange={(v) => set({ rotateX: v }, 'tilt.rotateX')}
      />
      <Slider
        label={t('style.effectsPanel.turn')}
        value={tilt.rotateY}
        min={A.min}
        max={A.max}
        step={1}
        disabled={!on}
        format={(v) => (degrees(v) === 0 ? t('style.effectsPanel.angle.straight') : v > 0 ? t('style.effectsPanel.angle.right', { n: fmt.count(degrees(v)) }) : t('style.effectsPanel.angle.left', { n: fmt.count(degrees(v)) }))}
        onChange={(v) => set({ rotateY: v }, 'tilt.rotateY')}
      />
      <Slider
        label={t('style.effectsPanel.perspective')}
        value={tilt.perspective}
        {...TILT_LIMITS.perspective}
        step={0.05}
        disabled={!on}
        format={(v) => (v === 0 ? t('style.effectsPanel.perspectiveNone') : pctFmt(v))}
        onChange={(v) => set({ perspective: v }, 'tilt.perspective')}
      />
      <Chips
        label={t('style.effectsPanel.tiltMovement')}
        value={movement}
        disabled={!on}
        onChange={(animate) => set({ animate })}
        options={[
          { value: 'none', label: t('style.effectsPanel.movementChip.none'), title: MOVEMENT().none },
          {
            value: 'cursor',
            label: t('style.effectsPanel.movementChip.cursor'),
            title: cursor.valid ? MOVEMENT().cursor : t('style.effectsPanel.noCursor'),
            disabled: !cursor.valid
          },
          { value: 'zoom', label: t('style.effectsPanel.movementChip.zoom'), title: MOVEMENT().zoom }
        ]}
      />
      <p className="hint" data-testid="tilt-movement">{noCursor ? t('style.effectsPanel.noCursorKeeps') : MOVEMENT()[movement]}</p>
      {!supported && (
        <p className="hint tilt-warn" data-testid="tilt-unsupported">{t('style.effectsPanel.tiltNeedsWebgl')}</p>
      )}
      <p className="hint">{t('style.effectsPanel.whileAShapeOr')}</p>
    </Section>
  )
}
