/**
 * The Animation section of a selected text, shape or title card (docs/design/editing-polish.md
 * §2.3, §12): Comes in, Goes out (the Graphics tab's motion names, plus Draw for arrows, lines and
 * boxes and Wipe for highlights and texts), Speed and Sound with a Play button. Blur and pixelate
 * never move: the section says so. Each change is one update (the Speed slider's drag merges).
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { soundEffect } from '../../../../shared/audio/soundLibrary'
import { calloutTarget, pickedMotion, withCallout, type CalloutTarget } from '../../../../shared/editor/calloutsEdit'
import { CALLOUT_SOUNDS, motionChoices } from '../../../../shared/editor/groupEdit'
import { MEDIA_SCHEME } from '../../../../shared/mediaUrl'
import { CALLOUT_DURATION } from '../../../../shared/render/calloutData'
import type { CalloutMotionKind, Project, SfxRef } from '../../../../shared/types'
import { holdGesture, useEditor } from '../context'
import type { Selection } from '../selection'
import { SelectRow } from './calloutControls'
import './callouts.css'

export const PRIVACY_NOTE = 'Blur and pixelate are fully on for their whole time, so nothing they hide shows.'

/** "0.25 seconds": the Speed slider's value text. */
export const secondsText = (v: number): string => `${v.toFixed(2)} seconds`

/** The tab an element sits in (the Inspector's body names it), or null outside one (tests). */
export function useTabOf(): [RefObject<HTMLDivElement>, string | null] {
  const ref = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<string | null>(null)
  useLayoutEffect(() => {
    const t = ref.current?.closest('[data-tab]')?.getAttribute('data-tab') ?? null
    if (t !== tab) setTab(t)
  })
  return [ref, tab]
}

/** The panel a callout belongs in: a shape's in the Shapes tab, a text's and a title card's in the Text tab. */
const belongsIn = (target: CalloutTarget, tab: string | null): boolean => tab === null || (target.ref.kind === 'shape' ? tab === 'shapes' : tab === 'text')

export function CalloutSection(props: { project: Project; selection: Selection }): JSX.Element | null {
  const { store } = useEditor()
  const [ref, tab] = useTabOf()
  const target = calloutTarget(props.project, props.selection)
  if (!target) return null
  const shown = belongsIn(target, tab)
  return (
    <div ref={ref} className="callout-mount">
      {shown && (
        <section className="insp-section callout-section" data-testid="callout-section">
          <h3>
            <span>Animation</span>
          </h3>
          {target.item ? <Motions target={target} update={(fn, key) => store.update(fn, key)} onHold={() => holdGesture(store)} /> : <p className="hint">{PRIVACY_NOTE}</p>}
        </section>
      )}
    </div>
  )
}

/** Comes in, Goes out, Speed and Sound of one callout. */
function Motions({ target, update, onHold }: { target: CalloutTarget; update: (fn: (p: Project) => Project, key?: string) => void; onHold: () => void }): JSX.Element {
  const item = target.item!
  const id = target.ref.id
  const pick = (side: 'enter' | 'exit', v: string): void =>
    update((p) => withCallout(p, target.ref, { [side]: v === 'default' ? null : pickedMotion(item, side, v as CalloutMotionKind, target[side]) }))
  const sound = target.sound ?? 'project'
  const speed = target.enter?.duration ?? null
  return (
    <>
      <SelectRow id="callout-enter" label="Comes in" value={target.enter?.kind ?? 'default'} options={motionChoices(item, 'enter')} onChange={(v) => pick('enter', v)} />
      {target.enter && speed !== null && (
        <label className="slider callout-field">
          <span className="slider-head">
            <span>Speed</span>
            <span className="muted">Comes in over {speed.toFixed(2)} s</span>
          </span>
          <input
            type="range"
            data-testid="callout-speed"
            aria-label="Speed"
            aria-valuetext={secondsText(speed)}
            min={CALLOUT_DURATION.min}
            max={CALLOUT_DURATION.max}
            step={0.05}
            value={speed}
            onPointerDown={onHold}
            onChange={(e) => update((p) => withCallout(p, target.ref, { enter: { ...target.enter!, duration: Number(e.target.value) } }), `callout-speed:${id}`)}
          />
        </label>
      )}
      <SelectRow id="callout-exit" label="Goes out" value={target.exit?.kind ?? 'default'} options={motionChoices(item, 'exit')} onChange={(v) => pick('exit', v)} />
      <div className="callout-sound-row">
        <SelectRow
          id="callout-sound"
          label="Sound"
          value={sound}
          options={CALLOUT_SOUNDS}
          onChange={(v) => update((p) => withCallout(p, target.ref, { sound: v === 'project' ? null : (v as 'none' | SfxRef) }))}
        />
        <PlayEffect sound={sound} />
      </div>
    </>
  )
}

/** The Sound row's Play toggle: plays the chosen library effect once (nothing to play for the project's rule or None). */
function PlayEffect({ sound }: { sound: string }): JSX.Element {
  const effect = sound.startsWith('sfx:') ? soundEffect(sound.slice(4)) : null
  const [playing, setPlaying] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stop = (): void => {
    audio.current?.pause()
    audio.current = null
    setPlaying(false)
  }
  useEffect(() => stop, [sound])
  const name = effect ? `Play ${effect.title}` : 'Play the sound'
  return (
    <button
      type="button"
      className="btn ghost callout-play"
      data-testid="callout-sound-play"
      aria-pressed={playing}
      aria-label={name}
      title={effect ? name : 'Choose an effect to hear it'}
      disabled={!effect}
      onClick={() => {
        if (playing || !effect) return stop()
        const a = new Audio(`${MEDIA_SCHEME}://sounds/${effect.prepared.file}`)
        audio.current = a
        a.onended = stop
        a.onerror = stop
        setPlaying(true)
        a.play().catch(stop)
      }}
    >
      {playing ? 'Stop' : 'Play'}
    </button>
  )
}
