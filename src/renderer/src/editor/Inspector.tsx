import { useState, type ReactNode } from 'react'
import { GRADIENTS, gradientCss } from '../../../shared/engine/backgrounds'
import { generateAutoZooms } from '../../../shared/engine/zoom'
import type { AspectRatio, ClickEvent, Corner, Project, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'

interface Props {
  project: Project
  update: (fn: (p: Project) => Project) => void
  selectedZoom: string | null
  setSelectedZoom: (id: string | null) => void
  clicks: ClickEvent[]
  cursorValid: boolean
  hasWebcam: boolean
  onBackgroundImage: () => void
}

type Tab = 'style' | 'cursor' | 'zoom' | 'camera'

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted">{props.format ? props.format(props.value) : props.value}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="insp-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

const ASPECTS: AspectRatio[] = ['auto', '16:9', '9:16', '1:1', '4:3']
const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const pctFmt = (v: number): string => `${Math.round(v * 100)}%`

export function Inspector(props: Props): JSX.Element {
  const { project, update } = props
  const [tab, setTab] = useState<Tab>('style')
  const { style, cursor, webcam } = project
  const zoom = project.zooms.find((z) => z.id === props.selectedZoom) ?? null

  const setStyle = (patch: Partial<Project['style']>): void => update((p) => ({ ...p, style: { ...p.style, ...patch } }))
  const setCursor = (patch: Partial<Project['cursor']>): void => update((p) => ({ ...p, cursor: { ...p.cursor, ...patch } }))
  const setWebcam = (patch: Partial<Project['webcam']>): void => update((p) => ({ ...p, webcam: { ...p.webcam, ...patch } }))
  const setZoom = (patch: Partial<ZoomSegment>): void =>
    update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === props.selectedZoom ? { ...z, ...patch, auto: false } : z)) }))

  const regenerate = (): void =>
    update((p) => {
      const manual = p.zooms.filter((z) => !z.auto)
      const auto = generateAutoZooms(props.clicks, p.duration).filter(
        (a) => !manual.some((m) => a.start < m.end && a.end > m.start)
      )
      return { ...p, autoZoom: true, zooms: [...manual, ...auto].sort((a, b) => a.start - b.start) }
    })

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'style', label: 'Style', icon: 'palette' },
    { id: 'cursor', label: 'Cursor', icon: 'cursor' },
    { id: 'zoom', label: 'Zoom', icon: 'zoom' },
    { id: 'camera', label: 'Camera', icon: 'camera' }
  ]

  return (
    <aside className="inspector">
      <nav className="insp-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </nav>

      <div className="insp-body">
        {tab === 'style' && (
          <>
            <Section title="Frame">
              <div className="chips">
                {ASPECTS.map((a) => (
                  <button key={a} className={`chip ${style.aspectRatio === a ? 'active' : ''}`} onClick={() => setStyle({ aspectRatio: a })}>
                    {a === 'auto' ? 'Auto' : a}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="Background">
              <div className="swatches">
                {GRADIENTS.map((g) => (
                  <button
                    key={g.id}
                    title={g.name}
                    className={`swatch ${style.background.type === 'gradient' && style.background.preset === g.id ? 'active' : ''}`}
                    style={{ background: gradientCss(g) }}
                    onClick={() => setStyle({ background: { type: 'gradient', preset: g.id } })}
                  />
                ))}
              </div>
              <div className="row">
                <label className="color-field">
                  <input
                    type="color"
                    value={style.background.type === 'color' ? style.background.color : '#1f2937'}
                    onChange={(e) => setStyle({ background: { type: 'color', color: e.target.value } })}
                  />
                  Solid colour
                </label>
                <button className={`btn ghost ${style.background.type === 'image' ? 'active' : ''}`} onClick={props.onBackgroundImage}>
                  <Icon name="image" size={16} /> Image…
                </button>
              </div>
            </Section>
            <Section title="Layout">
              <Slider label="Padding" value={style.padding} min={0} max={0.25} step={0.005} format={pctFmt} onChange={(v) => setStyle({ padding: v })} />
              <Slider label="Corner radius" value={style.cornerRadius} min={0} max={60} step={1} format={(v) => `${v}px`} onChange={(v) => setStyle({ cornerRadius: v })} />
              <Slider label="Shadow" value={style.shadow} min={0} max={1} step={0.05} format={pctFmt} onChange={(v) => setStyle({ shadow: v })} />
            </Section>
          </>
        )}

        {tab === 'cursor' && (
          <>
            {!props.cursorValid && (
              <p className="hint">Cursor data is only available for full-screen recordings. The original cursor stays visible in the video.</p>
            )}
            <Section title="Cursor">
              <Toggle label="Show smooth cursor" checked={cursor.show} disabled={!props.cursorValid} onChange={(v) => setCursor({ show: v })} />
              <Slider label="Size" value={cursor.size} min={0.6} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setCursor({ size: v })} />
              <Slider label="Smoothing" value={cursor.smoothing} min={0} max={1} step={0.05} format={pctFmt} onChange={(v) => setCursor({ smoothing: v })} />
              <Toggle label="Click effect" checked={cursor.clickEffect} onChange={(v) => setCursor({ clickEffect: v })} />
              <Toggle label="Hide when idle" checked={cursor.hideWhenIdle} onChange={(v) => setCursor({ hideWhenIdle: v })} />
            </Section>
            <p className="hint">
              If your recording also shows the Windows cursor, turn the smooth cursor off to avoid seeing two.
            </p>
          </>
        )}

        {tab === 'zoom' && (
          <>
            <Section title="Auto zoom">
              <p className="hint">
                {props.clicks.length > 0
                  ? `${props.clicks.length} clicks detected. Auto zoom focuses on where you click and follows your cursor.`
                  : 'No clicks were captured, so add zooms manually: press Z or double-click the zoom track.'}
              </p>
              <button className="btn" disabled={props.clicks.length === 0} onClick={regenerate}>
                <Icon name="refresh" size={16} /> Regenerate from clicks
              </button>
              <button className="btn ghost danger" disabled={project.zooms.length === 0} onClick={() => update((p) => ({ ...p, zooms: [] }))}>
                <Icon name="trash" size={16} /> Remove all zooms
              </button>
            </Section>
            {zoom ? (
              <Section title="Selected zoom">
                <Slider label="Zoom level" value={zoom.scale} min={1.1} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setZoom({ scale: v })} />
                <div className="chips">
                  <button
                    className={`chip ${zoom.focus.mode === 'cursor' ? 'active' : ''}`}
                    disabled={!props.cursorValid}
                    onClick={() => setZoom({ focus: { mode: 'cursor' } })}
                  >
                    Follow cursor
                  </button>
                  <button
                    className={`chip ${zoom.focus.mode === 'fixed' ? 'active' : ''}`}
                    onClick={() => setZoom({ focus: { mode: 'fixed', x: 0.5, y: 0.5 } })}
                  >
                    Fixed point
                  </button>
                </div>
                {zoom.focus.mode === 'fixed' && (
                  <>
                    <Slider label="Focus X" value={zoom.focus.x} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: v, y: (zoom.focus as { y: number }).y } })} />
                    <Slider label="Focus Y" value={zoom.focus.y} min={0} max={1} step={0.01} format={pctFmt} onChange={(v) => setZoom({ focus: { mode: 'fixed', x: (zoom.focus as { x: number }).x, y: v } })} />
                  </>
                )}
                <button
                  className="btn ghost danger"
                  onClick={() => {
                    update((p) => ({ ...p, zooms: p.zooms.filter((z) => z.id !== zoom.id) }))
                    props.setSelectedZoom(null)
                  }}
                >
                  <Icon name="trash" size={16} /> Delete zoom
                </button>
              </Section>
            ) : (
              <p className="hint">Select a zoom on the timeline to edit it.</p>
            )}
          </>
        )}

        {tab === 'camera' && (
          <>
            {!props.hasWebcam && <p className="hint">This recording has no camera. Pick a camera on the home screen before recording.</p>}
            <Section title="Camera">
              <Toggle label="Show camera" checked={webcam.show} disabled={!props.hasWebcam} onChange={(v) => setWebcam({ show: v })} />
              <Slider label="Size" value={webcam.size} min={0.12} max={0.45} step={0.01} format={pctFmt} onChange={(v) => setWebcam({ size: v })} />
              <div className="chips">
                <button className={`chip ${webcam.shape === 'circle' ? 'active' : ''}`} onClick={() => setWebcam({ shape: 'circle' })}>
                  Circle
                </button>
                <button className={`chip ${webcam.shape === 'rounded' ? 'active' : ''}`} onClick={() => setWebcam({ shape: 'rounded' })}>
                  Rounded
                </button>
              </div>
              <div className="corner-grid">
                {CORNERS.map((c) => (
                  <button key={c} className={`corner ${webcam.corner === c ? 'active' : ''} ${c}`} onClick={() => setWebcam({ corner: c })} title={c.replace('-', ' ')}>
                    <span />
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </aside>
  )
}
