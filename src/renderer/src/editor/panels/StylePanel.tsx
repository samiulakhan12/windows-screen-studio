import { useEffect, useState } from 'react'
import { saveErrorMessage } from '../../../../shared/editor/autosave'
import { ASPECT_RATIOS, LOOK_LIMITS, lookOf } from '../../../../shared/editor/styleDefaults'
import { ANIMATED_GRADIENTS, ANIMATED_SPEED, animatedSpeed, backgroundBlur, GRADIENTS, gradientCss } from '../../../../shared/engine/backgrounds'
import { BORDER_WIDTH, cardLook, DEFAULT_BORDER } from '../../../../shared/engine/cardStyle'
import { frameOf, frameTakesBorder, frameUsesRadius } from '../../../../shared/engine/deviceFrames'
import { WALLPAPERS } from '../../../../shared/engine/wallpapers'
import { activeWatermark } from '../../../../shared/engine/watermark'
import type { Background, DeviceFrame, DeviceFrameKind, Project, ShadowStyle } from '../../../../shared/types'
import { Icon } from '../../components/Icon'
import { useEditor } from '../context'
import { Chips, pctFmt, Section, Slider, Toggle } from '../controls'
import { CropLink, CropRow } from './CropRow'
import { PresetsSection } from './StylePresets'
import { animatedThumb, frameThumb, wallpaperThumb } from './styleThumbs'
import { WatermarkSection } from './WatermarkSection'
import './cursorPanel.css'
import './stylePanel.css'

const L = LOOK_LIMITS

type BackgroundGroup = 'gradient' | 'wallpaper' | 'animated'
const groupOf = (bg: Background): BackgroundGroup | null => (bg.type === 'gradient' || bg.type === 'wallpaper' || bg.type === 'animated' ? bg.type : null)

const FRAMES: { kind: DeviceFrameKind; label: string; title: string }[] = [
  { kind: 'none', label: 'None', title: 'Just the recording' },
  { kind: 'browser', label: 'Browser', title: 'A browser window with an address bar' },
  { kind: 'laptop', label: 'Laptop', title: 'A laptop screen on its base' },
  { kind: 'monitor', label: 'Monitor', title: 'A desktop monitor on a stand' },
  { kind: 'phone', label: 'Phone', title: 'A phone (on its side for landscape recordings)' }
]

const SHADOW_STYLES: { value: ShadowStyle; label: string; title: string }[] = [
  { value: 'soft', label: 'Soft', title: 'A soft drop shadow' },
  { value: 'hard', label: 'Hard', title: 'A solid shadow offset down and to the right' },
  { value: 'glow', label: 'Glow', title: 'A coloured glow all around' }
]

const SHADOW_COLORS = ['#111827', '#000000', '#8b5cf6', '#ec4899', '#38bdf8', '#facc15']
const BORDER_COLORS = ['#ffffff', '#111827', '#8b5cf6', '#38bdf8', '#f472b6', '#facc15']

/* ---------- Style ---------- */

export function StylePanel({
  project,
  onBackgroundImage,
  onNotice,
  onCrop
}: {
  project: Project
  onBackgroundImage: () => void
  onNotice: (message: string) => void
  /** Opens the crop tool, or shows the whole recording again. */
  onCrop: (action: 'edit' | 'reset') => void
}): JSX.Element {
  const { store } = useEditor()
  const { style } = project
  const setStyle = (patch: Partial<Project['style']>, key?: string): void => store.update((p) => ({ ...p, style: { ...p.style, ...patch } }), key)
  const frame = frameOf(style)
  const card = cardLook(style)
  const bg = style.background

  // Which swatches are shown; follows the background when it changes (undo, presets).
  const [group, setGroup] = useState<BackgroundGroup>(() => groupOf(bg) ?? 'gradient')
  useEffect(() => {
    const g = groupOf(bg)
    if (g) setGroup(g)
  }, [bg])

  const blur = backgroundBlur(bg)
  const chooseWallpaper = (id: string): void => setStyle({ background: blur > 0 ? { type: 'wallpaper', id, blur } : { type: 'wallpaper', id } })
  const chooseAnimated = (preset: string): void => setStyle({ background: { type: 'animated', preset, speed: bg.type === 'animated' ? animatedSpeed(bg) : 1 } })

  const setFrame = (patch: Partial<DeviceFrame>, key?: string): void =>
    store.update((p) => ({ ...p, style: { ...p.style, frame: { kind: 'none', theme: 'light', ...p.style.frame, ...patch } } }), key)

  const borderOk = frameTakesBorder(frame)
  const border = style.border ?? { ...DEFAULT_BORDER, width: 0 }
  const setBorder = (patch: Partial<typeof border>, key?: string): void =>
    store.update((p) => ({ ...p, style: { ...p.style, border: { ...(p.style.border ?? { ...DEFAULT_BORDER, width: 0 }), ...patch } } }), key)

  return (
    <>
      <PresetsSection project={project} onNotice={onNotice} />

      <Section title="Frame" aside={<CropLink project={project} onCrop={onCrop} />}>
        <Chips label="Aspect ratio" value={style.aspectRatio} onChange={(a) => setStyle({ aspectRatio: a })} options={ASPECT_RATIOS.map((a) => ({ value: a, label: a === 'auto' ? 'Auto' : a }))} />
        <CropRow project={project} onCrop={onCrop} />
      </Section>

      <Section title="Background">
        <div className="compact-chips">
          <Chips
            label="Background kind"
            value={group}
            onChange={setGroup}
            options={[
              { value: 'gradient', label: 'Gradients' },
              { value: 'wallpaper', label: 'Wallpapers' },
              { value: 'animated', label: 'Animated' }
            ]}
          />
        </div>
        {group === 'gradient' && (
          <div className="swatches">
            {GRADIENTS.map((g) => (
              <button
                key={g.id}
                title={g.name}
                aria-label={`${g.name} background`}
                className={`swatch ${bg.type === 'gradient' && bg.preset === g.id ? 'active' : ''}`}
                style={{ background: gradientCss(g) }}
                onClick={() => setStyle({ background: { type: 'gradient', preset: g.id } })}
              />
            ))}
          </div>
        )}
        {group === 'wallpaper' && (
          <div className="swatches wide" data-testid="wallpapers">
            {WALLPAPERS.map((w) => (
              <button
                key={w.id}
                title={w.name}
                aria-label={`${w.name} wallpaper`}
                aria-pressed={bg.type === 'wallpaper' && bg.id === w.id}
                className={`swatch ${bg.type === 'wallpaper' && bg.id === w.id ? 'active' : ''}`}
                style={{ backgroundImage: `url(${wallpaperThumb(w.id)})` }}
                onClick={() => chooseWallpaper(w.id)}
              />
            ))}
          </div>
        )}
        {group === 'animated' && (
          <div className="swatches wide" data-testid="animated-backgrounds">
            {ANIMATED_GRADIENTS.map((a) => (
              <button
                key={a.id}
                title={`${a.name} (moves while the video plays)`}
                aria-label={`${a.name} animated background`}
                aria-pressed={bg.type === 'animated' && bg.preset === a.id}
                className={`swatch animated ${bg.type === 'animated' && bg.preset === a.id ? 'active' : ''}`}
                style={{ backgroundImage: `url(${animatedThumb(a.id)})` }}
                onClick={() => chooseAnimated(a.id)}
              />
            ))}
          </div>
        )}
        <div className="row">
          <label className="color-field">
            <input
              type="color"
              value={bg.type === 'color' ? bg.color : '#1f2937'}
              onChange={(e) => setStyle({ background: { type: 'color', color: e.target.value } }, 'style.color')}
            />
            Solid colour
          </label>
          <button className={`btn ghost ${bg.type === 'image' ? 'active' : ''}`} onClick={onBackgroundImage}>
            <Icon name="image" size={16} /> Image…
          </button>
        </div>
        {(bg.type === 'image' || bg.type === 'wallpaper') && (
          <Slider
            label="Background blur"
            value={blur}
            {...L.backgroundBlur}
            step={0.05}
            format={(v) => (v === 0 ? 'Off' : pctFmt(v))}
            onChange={(v) => setStyle({ background: { ...bg, blur: v } }, 'style.background.blur')}
          />
        )}
        {bg.type === 'animated' && (
          <>
            <Slider
              label="Motion speed"
              value={animatedSpeed(bg)}
              {...ANIMATED_SPEED}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(v) => setStyle({ background: { ...bg, speed: v } }, 'style.background.speed')}
            />
            <p className="hint">Drifts slowly while the video plays and loops without a seam.</p>
          </>
        )}
      </Section>

      <Section title="Layout">
        <Slider label="Padding" value={style.padding} {...L.padding} step={0.005} format={pctFmt} onChange={(v) => setStyle({ padding: v }, 'style.padding')} />
        <Slider
          label="Corner radius"
          value={style.cornerRadius}
          {...L.cornerRadius}
          step={1}
          format={(v) => `${v}px`}
          disabled={!frameUsesRadius(frame)}
          onChange={(v) => setStyle({ cornerRadius: v }, 'style.radius')}
        />
        {!frameUsesRadius(frame) && <p className="hint">The device frame sets the corners of the recording.</p>}
      </Section>

      <Section title="Device frame">
        <div className="frame-tiles" role="radiogroup" aria-label="Device frame">
          {FRAMES.map((f) => {
            const active = (frame?.kind ?? 'none') === f.kind
            return (
              <button
                key={f.kind}
                role="radio"
                aria-checked={active}
                aria-label={`${f.label} frame`}
                title={f.title}
                className={`frame-tile ${active ? 'active' : ''}`}
                onClick={() => setFrame({ kind: f.kind })}
              >
                <img src={frameThumb({ kind: f.kind, theme: frame?.theme ?? 'light' }, f.kind === 'phone')} alt="" draggable={false} />
                <span>{f.label}</span>
              </button>
            )
          })}
        </div>
        {frame && (
          <Chips
            label="Frame theme"
            value={frame.theme}
            onChange={(theme) => setFrame({ theme })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        )}
        {frame?.kind === 'browser' && (
          <label className="field-label stacked">
            Address bar
            <input
              className="text-input"
              aria-label="Address bar text"
              placeholder={project.name}
              maxLength={120}
              value={style.frame?.title ?? ''}
              onChange={(e) => setFrame({ title: e.target.value }, 'style.frame.title')}
            />
          </label>
        )}
      </Section>

      <Section title="Shadow">
        <Chips label="Shadow style" value={card.shadowStyle} onChange={(s) => setStyle({ shadowStyle: s })} options={SHADOW_STYLES} />
        <Slider label="Shadow" value={style.shadow} {...L.shadow} step={0.05} format={pctFmt} onChange={(v) => setStyle({ shadow: v }, 'style.shadow')} />
        {card.shadowStyle !== 'soft' && (
          <ColorDots label="Shadow colour" value={card.shadowColor} presets={SHADOW_COLORS} onChange={(c, key) => setStyle({ shadowColor: c }, key)} mergeKey="style.shadowColor" />
        )}
        {style.padding === 0 && style.shadow > 0 && <p className="hint">Add some padding to make room for the shadow.</p>}
      </Section>

      <Section title="Border">
        <Slider
          label="Border width"
          value={borderOk ? border.width : 0}
          {...BORDER_WIDTH}
          step={1}
          format={(v) => (v === 0 ? 'None' : `${v}px`)}
          disabled={!borderOk}
          onChange={(v) => setBorder({ width: v }, 'style.border.width')}
        />
        <Toggle
          label="Frosted glass"
          title="A see-through, frosted border instead of a solid colour"
          checked={borderOk && border.width > 0 && border.glass}
          disabled={!borderOk || border.width === 0}
          onChange={(v) => setBorder({ glass: v })}
        />
        <ColorDots
          label="Border colour"
          value={border.color}
          presets={BORDER_COLORS}
          disabled={!borderOk || border.width === 0 || border.glass}
          onChange={(c, key) => setBorder({ color: c }, key)}
          mergeKey="style.border.color"
        />
        {!borderOk && <p className="hint">Device frames have their own bezel, so they take no border.</p>}
      </Section>

      <WatermarkSection project={project} />

      <StyleDefaultsSection project={project} onNotice={onNotice} />
    </>
  )
}

/* ---------- colours ---------- */

function ColorDots({
  label,
  value,
  presets,
  disabled,
  onChange,
  mergeKey
}: {
  label: string
  value: string
  presets: string[]
  disabled?: boolean
  onChange: (color: string, key?: string) => void
  mergeKey: string
}): JSX.Element {
  const v = value.toLowerCase()
  const custom = !presets.includes(v)
  return (
    <div className={`color-row ${disabled ? 'disabled' : ''}`} role="group" aria-label={label}>
      {presets.map((c) => (
        <button
          key={c}
          className={`color-dot ${v === c ? 'active' : ''}`}
          style={{ background: c }}
          disabled={disabled}
          title={c}
          aria-label={`${label} ${c}`}
          aria-pressed={v === c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className={`color-dot custom ${custom ? 'active' : ''}`} title="Pick any colour" style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={`${label} (any colour)`} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}

/* ---------- defaults ---------- */

/** Saves this project's look (style, cursor, camera, effects, zoom style, watermark) as the start of every new recording. */
function StyleDefaultsSection({ project, onNotice }: { project: Project; onNotice: (message: string) => void }): JSX.Element {
  // null while unknown (the saved state is read once when the Style tab opens).
  const [saved, setSaved] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    window.api
      .getStyleDefaults()
      .then((d) => live && setSaved(!!d))
      .catch(() => live && setSaved(false))
    return () => {
      live = false
    }
  }, [])

  const run = async (action: () => Promise<string>, failure: string): Promise<void> => {
    setBusy(true)
    try {
      onNotice(await action())
    } catch (err) {
      onNotice(`${failure}: ${saveErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      const stored = await window.api.saveStyleDefaults(lookOf(project))
      setSaved(true)
      const left: string[] = []
      if (project.style.background.type === 'image') left.push('image backgrounds are not included')
      if (activeWatermark(project)?.kind === 'image' && !stored?.watermark) left.push('the watermark logo could not be kept')
      return left.length ? `Saved as default (${left.join('; ')})` : 'Saved as default for new recordings'
    }, 'Could not save the defaults')

  const reset = (): Promise<void> =>
    run(async () => {
      await window.api.resetStyleDefaults()
      setSaved(false)
      return 'Defaults reset: new recordings use the built-in look'
    }, 'Could not reset the defaults')

  return (
    <Section title="New recordings">
      <p className="hint" data-testid="style-defaults-state">
        {saved
          ? 'New recordings start with your saved look: background, frame, layout, cursor, camera, zoom style, watermark and effects.'
          : 'New recordings start with the built-in look. Save this one to use it for every new recording.'}
      </p>
      <div className="defaults-actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={16} /> Save as default for new recordings
        </button>
        <button className="btn ghost" disabled={busy || !saved} onClick={() => void reset()} title={saved ? 'Go back to the built-in look for new recordings' : 'No defaults are saved'}>
          <Icon name="refresh" size={16} /> Reset defaults
        </button>
      </div>
    </Section>
  )
}
