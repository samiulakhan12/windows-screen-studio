/**
 * The colour controls of the screen or the camera: looks, sliders, LUT, Compare, Reset
 * (docs/design/editing-polish.md §2.5, §12). Each change is one store update (a slider's drag
 * merges through its key); Reset and Delete are announced in the section's live region.
 *
 * - Look: a radio group of chips, each with a text label and a thumbnail of the playhead's frame
 *   graded with that look (decorative). The screen offers None, Natural, Vivid and Mono only, and
 *   Mono says coloured text may become harder to read.
 * - Sliders −100 to +100 (Exposure −2 to +2 stops), with a centre detent while dragged and a value
 *   text ("Warmer, +20", "No change"): arrows 1, Page Up and Page Down 10, Home and End the ends,
 *   Delete back to 0. A slider not at 0 has its own Reset button.
 * - LUT: Import a LUT (.cube)…, then its title, size, strength and Remove; a missing or changed
 *   file is said.
 * - Compare (the preview only), Reset colour, and for the camera Auto colour.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { resetSlider, withGrade, withLook, withLut } from '../../../../shared/editor/colourEdit'
import { gradePixelsCpu, gradeTable, resolveGrade } from '../../../../shared/render/colorGrade'
import { EXPOSURE_RANGE } from '../../../../shared/render/gradeData'
import { LOOK_IDS, lookOf, SCREEN_LOOKS } from '../../../../shared/render/looks'
import type { ColorGrade, LookId, Project } from '../../../../shared/types'
import { gradeBackendReason, onGradeBackend } from '../../render/gradeLayer'
import { lutProblem, onLutReady } from '../../render/lutCache'
import { autoColourBusy, onAutoColour } from '../autoColourRun'
import { onCompare, toggleCompare } from '../compareColour'
import { holdGesture, useEditor } from '../context'
import { useGroup } from '../groupContext'
import './colour.css'

type Which = 'screen' | 'camera'
export type ColourSliderKey = 'temperature' | 'tint' | 'brightness' | 'contrast' | 'saturation' | 'highlights' | 'shadows' | 'vibrance' | 'exposure'

export const COLOUR_COPY = {
  monoHint: 'Coloured text may become harder to read.',
  cpuNote: 'This PC grades colour without graphics acceleration, so the preview may play less smoothly. The export looks the same.',
  autoHint: 'Balances the camera’s colour and brightness from a few frames, on this PC. Review mode lists it.',
  importLut: 'Import a LUT (.cube)…',
  reset: 'Colour reset',
  compareHint: 'Shows the preview without colour while it is on. The export keeps the colour.'
} as const

export const SLIDER_LABELS: Readonly<Record<ColourSliderKey, string>> = {
  temperature: 'Temperature',
  tint: 'Tint',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  highlights: 'Highlights',
  shadows: 'Shadows',
  vibrance: 'Vibrance',
  exposure: 'Exposure'
}
const MAIN: readonly ColourSliderKey[] = ['temperature', 'tint', 'brightness', 'contrast', 'saturation']
const moreOf = (which: Which): readonly ColourSliderKey[] => (which === 'camera' ? ['highlights', 'shadows', 'vibrance', 'exposure'] : ['highlights', 'shadows', 'vibrance'])

/** A slider's scale on screen: −100..100 in 1 (the stored −1..1), or −2..2 stops in 0.1. */
interface Scale {
  min: number
  max: number
  step: number
  page: number
  /** Within this of 0 a drag rests at 0 (the centre detent). */
  detent: number
  toUi(v: number): number
  fromUi(u: number): number
}
const UNIT: Scale = { min: -100, max: 100, step: 1, page: 10, detent: 3, toUi: (v) => Math.round(v * 100), fromUi: (u) => u / 100 }
const STOPS: Scale = {
  min: EXPOSURE_RANGE.min,
  max: EXPOSURE_RANGE.max,
  step: 0.1,
  page: 0.5,
  detent: 0.05,
  toUi: (v) => Math.round(v * 10) / 10,
  fromUi: (u) => Math.round(u * 10) / 10
}
const scaleOf = (key: ColourSliderKey): Scale => (key === 'exposure' ? STOPS : UNIT)

/** "+20", "−15" (a real minus sign). */
const signed = (u: number): string => (u > 0 ? `+${u}` : `−${Math.abs(u)}`)

/** A slider's value text: "Warmer, +20", "Cooler, −15", "More magenta, +5", "+0.5 stops", "No change" at 0. */
export function colourValueText(key: ColourSliderKey, u: number): string {
  if (u === 0) return 'No change'
  if (key === 'temperature') return `${u > 0 ? 'Warmer' : 'Cooler'}, ${signed(u)}`
  if (key === 'tint') return `${u > 0 ? 'More magenta' : 'Greener'}, ${signed(u)}`
  if (key === 'exposure') return `${signed(u)} ${Math.abs(u) === 1 ? 'stop' : 'stops'}`
  return signed(u)
}

const percentText = (v: number): string => `${Math.round(v * 100)} percent`
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** The looks a source offers, None first. */
export const looksFor = (which: Which): readonly (LookId | null)[] => [null, ...(which === 'screen' ? SCREEN_LOOKS : LOOK_IDS)]

/* ---------- thumbnails ---------- */

const THUMB_W = 96
const THUMB_H = 54
let thumbSource: { image: unknown; time: number; pixels: Uint8ClampedArray } | null = null

/** The frame `video` shows, 96 × 54 (kept while it shows the same time). */
function thumbPixels(video: HTMLVideoElement): Uint8ClampedArray | null {
  if (video.readyState < 2 || typeof document === 'undefined') return null
  if (thumbSource && thumbSource.image === video && thumbSource.time === video.currentTime) return thumbSource.pixels
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.canvas.width = THUMB_W
  ctx.canvas.height = THUMB_H
  try {
    ctx.drawImage(video, 0, 0, THUMB_W, THUMB_H)
    const pixels = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data
    thumbSource = { image: video, time: video.currentTime, pixels }
    return pixels
  } catch {
    return null
  }
}

/** A look's chip picture: the playhead's frame graded with it, by the same maths as the video. */
function LookThumb({ which, look }: { which: Which; look: LookId | null }): JSX.Element {
  const { player } = useEditor()
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    const video = which === 'screen' ? player.screen : player.webcam
    const ctx = c?.getContext?.('2d')
    if (!c || !ctx || !video) return
    const src = thumbPixels(video)
    if (!src) return
    const px = new Uint8ClampedArray(src)
    const g = look ? resolveGrade({ look }, which) : null
    if (g) gradePixelsCpu(px, g, gradeTable(g), null)
    const img = ctx.createImageData(THUMB_W, THUMB_H)
    img.data.set(px)
    ctx.putImageData(img, 0, 0)
  }, [which, look, player])
  return <canvas ref={canvas} className="colour-look-thumb" width={THUMB_W} height={THUMB_H} aria-hidden="true" />
}

/* ---------- one slider ---------- */

function ColourSlider(props: { k: ColourSliderKey; value: number; onSet: (v: number, key: string) => void; onReset: () => void; mergeKey: string }): JSX.Element {
  const { store } = useEditor()
  const { k, value } = props
  const scale = scaleOf(k)
  const u = scale.toUi(value)
  const dragging = useRef(false)
  const label = SLIDER_LABELS[k]
  const set = (next: number): void => props.onSet(scale.fromUi(Math.min(scale.max, Math.max(scale.min, next))), props.mergeKey)
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (u !== 0) props.onReset()
      return
    }
    const next =
      e.key === 'Home' ? scale.min : e.key === 'End' ? scale.max : e.key === 'PageUp' ? u + scale.page : e.key === 'PageDown' ? u - scale.page : null
    if (next === null) return
    e.preventDefault()
    set(Math.round(next / scale.step) * scale.step)
  }
  return (
    <div className="colour-slider-row">
      <label className="slider">
        <span className="slider-head">
          <span>{label}</span>
          <span className="muted">{u === 0 ? '0' : signed(u)}</span>
        </span>
        <input
          type="range"
          data-testid={`colour-slider-${k}`}
          aria-label={label}
          aria-valuetext={colourValueText(k, u)}
          min={scale.min}
          max={scale.max}
          step={scale.step}
          value={u}
          onPointerDown={() => {
            dragging.current = true
            holdGesture(store)
          }}
          onPointerUp={() => (dragging.current = false)}
          onChange={(e) => {
            const raw = Number(e.target.value)
            // The centre detent, while dragged (the keys step through 0 as they do elsewhere).
            set(dragging.current && Math.abs(raw) <= scale.detent ? 0 : raw)
          }}
          onKeyDown={onKey}
        />
      </label>
      {u !== 0 && (
        <button type="button" className="colour-reset-one" data-testid={`colour-reset-${k}`} aria-label={`Reset ${label}`} title={`Reset ${label}`} onClick={props.onReset}>
          Reset
        </button>
      )}
    </div>
  )
}

/* ---------- the controls ---------- */

export function ColourControls(props: { project: Project; which: 'screen' | 'camera' }): JSX.Element {
  const { project, which } = props
  const { store, player } = useEditor()
  const group = useGroup()
  const ids = useId()
  const grade: ColorGrade = project.grade?.[which] ?? {}
  const more = moreOf(which)
  const [open, setOpen] = useState(() => more.some((k) => (grade[k] ?? 0) !== 0))
  const [said, setSaid] = useState('')
  const [importing, setImporting] = useState(false)
  const comparing = useSyncExternalStore(onCompare, () => player.comparing)
  const cpu = useSyncExternalStore(onGradeBackend, gradeBackendReason)
  const problem = useSyncExternalStore(onLutReady, () => (grade.lut ? lutProblem(project, which) : null))
  const busy = useSyncExternalStore(onAutoColour, autoColourBusy)
  const groupRef = useRef<HTMLDivElement>(null)

  /** Announced in the live region (the same words again are announced again). */
  const say = (text: string): void => setSaid((was) => (was === text ? `${text} ` : text))
  const update = (fn: (p: Project) => Project, key?: string): void => store.update(fn, key)

  const looks = looksFor(which)
  const look = grade.look ?? null
  const pick = (id: LookId | null): void => update((p) => withLook(p, which, id))
  const lookLabel = (id: LookId | null): string => (id ? (lookOf(id)?.label ?? id) : 'None')
  const onLookKeys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = looks.indexOf(look)
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? looks.length - 1 : null
    if (next === null) return
    e.preventDefault()
    const to = looks[(next + looks.length) % looks.length]
    pick(to)
    const chips = groupRef.current?.querySelectorAll?.('[role="radio"]')
    ;(chips?.[looks.indexOf(to)] as HTMLElement | undefined)?.focus?.()
  }

  const setSlider = (k: ColourSliderKey) => (v: number, key: string): void => update((p) => withGrade(p, which, { [k]: v }), key)
  const reset = (k: ColourSliderKey) => (): void => {
    update((p) => resetSlider(p, which, k))
    say(`${SLIDER_LABELS[k]} reset`)
  }
  const sliders = (keys: readonly ColourSliderKey[]): JSX.Element[] =>
    keys.map((k) => <ColourSlider key={k} k={k} value={grade[k] ?? 0} mergeKey={`colour:${which}:${k}`} onSet={setSlider(k)} onReset={reset(k)} />)

  const importLut = async (): Promise<void> => {
    setImporting(true)
    try {
      const picked = await window.api.pickAsset(project.id, 'lut')
      if (!picked?.lut) return
      const lut = { file: picked.path, ...picked.lut }
      update((p) => withLut(p, which, lut))
      say(`LUT ${lut.title} imported`)
    } catch (err) {
      group.notice(ipcMessage(err))
    } finally {
      setImporting(false)
    }
  }
  const lut = grade.lut ?? null
  const monoHint = `${ids}-mono`
  const anything = Object.keys(grade).length > 0

  return (
    <div className="colour-controls">
      <div className="colour-row-label" id={`${ids}-look`}>
        Look
      </div>
      <div ref={groupRef} className="colour-looks" role="radiogroup" aria-labelledby={`${ids}-look`} data-testid="colour-look" onKeyDown={onLookKeys}>
        {looks.map((id) => {
          const on = id === look
          return (
            <button
              key={id ?? 'none'}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={`colour-look ${on ? 'active' : ''}`}
              data-look={id ?? 'none'}
              aria-describedby={which === 'screen' && id === 'mono' ? monoHint : undefined}
              title={which === 'screen' && id === 'mono' ? COLOUR_COPY.monoHint : undefined}
              onClick={() => pick(id)}
            >
              <LookThumb which={which} look={id} />
              <span className="colour-look-name">{lookLabel(id)}</span>
            </button>
          )
        })}
      </div>
      {which === 'screen' && (
        <p className={`hint ${look === 'mono' ? '' : 'sr-only'}`} id={monoHint}>
          {COLOUR_COPY.monoHint}
        </p>
      )}
      {look && (
        <label className="slider">
          <span className="slider-head">
            <span>Strength</span>
            <span className="muted">{`${Math.round((grade.lookStrength ?? 1) * 100)}%`}</span>
          </span>
          <input
            type="range"
            data-testid="colour-look-strength"
            aria-label={`Strength of ${lookLabel(look)}`}
            aria-valuetext={percentText(grade.lookStrength ?? 1)}
            min={0}
            max={100}
            step={1}
            value={Math.round((grade.lookStrength ?? 1) * 100)}
            onPointerDown={() => holdGesture(store)}
            onChange={(e) => update((p) => withLook(p, which, look, Number(e.target.value) / 100), `colour:${which}:look-strength`)}
          />
        </label>
      )}

      {sliders(MAIN)}
      <button type="button" className="colour-more" data-testid="colour-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Fewer' : 'More'}
      </button>
      {open && sliders(more)}

      <div className="colour-lut">
        {lut && (
          <>
            <p className="colour-lut-line">
              <span className="colour-lut-title" data-testid="lut-title" dir="auto">
                {lut.title}
              </span>
              <span className="muted" data-testid="lut-size">{`${lut.size} × ${lut.size} × ${lut.size}`}</span>
            </p>
            <label className="slider">
              <span className="slider-head">
                <span>LUT strength</span>
                <span className="muted">{`${Math.round((lut.strength ?? 1) * 100)}%`}</span>
              </span>
              <input
                type="range"
                data-testid="lut-strength"
                aria-label="LUT strength"
                aria-valuetext={percentText(lut.strength ?? 1)}
                min={0}
                max={100}
                step={1}
                value={Math.round((lut.strength ?? 1) * 100)}
                onPointerDown={() => holdGesture(store)}
                onChange={(e) => update((p) => withGrade(p, which, { lut: { ...lut, strength: Number(e.target.value) / 100 } }), `colour:${which}:lut-strength`)}
              />
            </label>
            {problem && (
              <p className="colour-problem" data-testid="lut-problem">
                {problem}
              </p>
            )}
          </>
        )}
        <div className="colour-buttons">
          <button type="button" className="btn small" data-testid="lut-import" disabled={importing} onClick={() => void importLut()}>
            {COLOUR_COPY.importLut}
          </button>
          {lut && (
            <button
              type="button"
              className="btn small"
              data-testid="lut-remove"
              onClick={() => {
                update((p) => withLut(p, which, null))
                say('LUT removed')
              }}
            >
              Remove LUT
            </button>
          )}
        </div>
      </div>

      <div className="colour-buttons">
        <button type="button" className={`btn small ${comparing ? 'active' : ''}`} data-testid="colour-compare" aria-pressed={comparing} title={COLOUR_COPY.compareHint} onClick={() => void toggleCompare(player)}>
          Compare
        </button>
        <button
          type="button"
          className="btn small"
          data-testid="colour-reset"
          disabled={!anything}
          onClick={() => {
            update((p) => withGrade(p, which, null))
            say(COLOUR_COPY.reset)
          }}
        >
          Reset colour
        </button>
        {which === 'camera' && (
          <button type="button" className="btn small" data-testid="auto-colour" disabled={busy} aria-describedby={`${ids}-auto`} onClick={() => group.command('autoColour')}>
            {busy ? 'Balancing…' : 'Auto colour'}
          </button>
        )}
      </div>
      {which === 'camera' && (
        <p className="hint" id={`${ids}-auto`}>
          {COLOUR_COPY.autoHint}
        </p>
      )}
      {cpu && (
        <p className="hint colour-cpu-note" data-testid="colour-cpu-note">
          {COLOUR_COPY.cpuNote}
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
