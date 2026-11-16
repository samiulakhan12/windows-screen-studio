import { useEffect, useState } from 'react'
import { saveErrorMessage } from '../../../../shared/editor/autosave'
import { editorFrame, followsAction } from '../../../../shared/editor/followEdit'
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
import { useGroup } from '../groupContext'
import { BrandKitBar } from './BrandKitBar'
import { CropLink, CropRow } from './CropRow'
import { FollowSection } from './FollowSection'
import { PresetsSection } from './StylePresets'
import { animatedThumb, frameThumb, wallpaperThumb } from './styleThumbs'
import { WatermarkSection } from './WatermarkSection'
import './cursorPanel.css'
import './stylePanel.css'
import { t, uiLanguage } from '../../../../shared/i18n/t'
import { fmt } from '../../../../shared/i18n/fmt'

const L = LOOK_LIMITS

type BackgroundGroup = 'gradient' | 'wallpaper' | 'animated'
const groupOf = (bg: Background): BackgroundGroup | null => (bg.type === 'gradient' || bg.type === 'wallpaper' || bg.type === 'animated' ? bg.type : null)

const FRAMES = (): { kind: DeviceFrameKind; label: string; title: string }[] => [
  { kind: 'none', label: t('common.state.none'), title: t('style.stylePanel.frames.none.title') },
  { kind: 'browser', label: t('style.stylePanel.frames.browser'), title: t('style.stylePanel.frames.browser.title') },
  { kind: 'laptop', label: t('style.stylePanel.frames.laptop'), title: t('style.stylePanel.frames.laptop.title') },
  { kind: 'monitor', label: t('style.stylePanel.frames.monitor'), title: t('style.stylePanel.frames.monitor.title') },
  { kind: 'phone', label: t('style.stylePanel.frames.phone'), title: t('style.stylePanel.frames.phone.title') }
]

const SHADOW_STYLES = (): { value: ShadowStyle; label: string; title: string }[] => [
  { value: 'soft', label: t('style.stylePanel.shadowStyles.soft'), title: t('style.stylePanel.shadowStyles.soft.title') },
  { value: 'hard', label: t('style.stylePanel.shadowStyles.hard'), title: t('style.stylePanel.shadowStyles.hard.title') },
  { value: 'glow', label: t('style.stylePanel.shadowStyles.glow'), title: t('style.stylePanel.shadowStyles.glow.title') }
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
  const { command } = useGroup()
  const { style } = project
  // The recording as cropped, and whether its frame follows the action (docs/design/vertical-video.md §2.5, §2.10).
  const { vw, vh } = editorFrame(project)
  const following = followsAction(project)
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

      <Section title={t('style.stylePanel.frame')} aside={<CropLink project={project} onCrop={onCrop} />}>
        <Chips label={t('style.stylePanel.aspectRatio')} value={style.aspectRatio} onChange={(a) => setStyle({ aspectRatio: a })} options={ASPECT_RATIOS.map((a) => ({ value: a, label: a === 'auto' ? t('style.stylePanel.aspectAuto') : a }))} />
        <CropRow project={project} onCrop={onCrop} />
      </Section>

      <FollowSection project={project} vw={vw} vh={vh} onMakeVertical={() => command('makeVertical')} />

      <Section title={t('common.label.background')}>
        <div className="compact-chips">
          <Chips
            label={t('style.stylePanel.backgroundKind')}
            value={group}
            onChange={setGroup}
            options={[
              { value: 'gradient', label: t('style.stylePanel.backgroundKinds.gradient') },
              { value: 'wallpaper', label: t('style.stylePanel.backgroundKinds.wallpaper') },
              { value: 'animated', label: t('style.stylePanel.backgroundKinds.animated') }
            ]}
          />
        </div>
        {group === 'gradient' && (
          <div className="swatches">
            {GRADIENTS.map((g) => (
              <button
                key={g.id}
                title={g.name}
                aria-label={t('style.stylePanel.background2', { name: String(g.name) })}
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
                aria-label={t('style.stylePanel.wallpaper', { name: String(w.name) })}
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
                title={t('style.stylePanel.movesWhileTheVideo', { name: String(a.name) })}
                aria-label={t('style.stylePanel.animatedBackground', { name: String(a.name) })}
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
            />{t('style.stylePanel.solidColour')}</label>
          <button className={`btn ghost ${bg.type === 'image' ? 'active' : ''}`} onClick={onBackgroundImage}>
            <Icon name="image" size={16} /> {t('style.stylePanel.image')}
          </button>
        </div>
        {(bg.type === 'image' || bg.type === 'wallpaper') && (
          <Slider
            label={t('style.stylePanel.backgroundBlur')}
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
              label={t('style.stylePanel.motionSpeed')}
              value={animatedSpeed(bg)}
              {...ANIMATED_SPEED}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(v) => setStyle({ background: { ...bg, speed: v } }, 'style.background.speed')}
            />
            <p className="hint">{t('style.stylePanel.driftsSlowlyWhileThe')}</p>
          </>
        )}
      </Section>

      <Section title={t('common.label.layout')}>
        <Slider label={t('style.stylePanel.padding')} value={style.padding} {...L.padding} step={0.005} format={pctFmt} onChange={(v) => setStyle({ padding: v }, 'style.padding')} />
        <Slider
          label={t('style.stylePanel.cornerRadius')}
          value={style.cornerRadius}
          {...L.cornerRadius}
          step={1}
          format={(v) => `${v}px`}
          disabled={!frameUsesRadius(frame)}
          onChange={(v) => setStyle({ cornerRadius: v }, 'style.radius')}
        />
        {!frameUsesRadius(frame) && <p className="hint">{t('style.stylePanel.theDeviceFrameSets')}</p>}
      </Section>

      <Section title={t('style.stylePanel.deviceFrame')}>
        <div className="frame-tiles" role="radiogroup" aria-label={t('style.stylePanel.deviceFrame')}>
          {FRAMES().map((f) => {
            const active = (frame?.kind ?? 'none') === f.kind
            return (
              <button
                key={f.kind}
                role="radio"
                aria-checked={active}
                aria-label={t('style.stylePanel.frame2', { label: String(f.label) })}
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
            label={t('style.stylePanel.frameTheme')}
            value={frame.theme}
            onChange={(theme) => setFrame({ theme })}
            options={[
              { value: 'light', label: t('style.stylePanel.frameThemes.light') },
              { value: 'dark', label: t('style.stylePanel.frameThemes.dark') }
            ]}
          />
        )}
        {following && frame && <p className="hint">{t('style.stylePanel.deviceFramesAreNot')}</p>}
        {frame?.kind === 'browser' && (
          <label className="field-label stacked">{t('style.stylePanel.addressBar')}<input
              className="text-input"
              aria-label={t('style.stylePanel.addressBarText')}
              placeholder={project.name}
              maxLength={120}
              value={style.frame?.title ?? ''}
              onChange={(e) => setFrame({ title: e.target.value }, 'style.frame.title')}
            />
          </label>
        )}
      </Section>

      <Section title={t('common.label.shadow')}>
        <Chips label={t('style.stylePanel.shadowStyle')} value={card.shadowStyle} onChange={(s) => setStyle({ shadowStyle: s })} options={SHADOW_STYLES()} />
        <Slider label={t('common.label.shadow')} value={style.shadow} {...L.shadow} step={0.05} format={pctFmt} onChange={(v) => setStyle({ shadow: v }, 'style.shadow')} />
        {card.shadowStyle !== 'soft' && (
          <ColorDots label={t('style.stylePanel.shadowColour')} value={card.shadowColor} presets={SHADOW_COLORS} onChange={(c, key) => setStyle({ shadowColor: c }, key)} mergeKey="style.shadowColor" />
        )}
        {style.padding === 0 && style.shadow > 0 && <p className="hint">{t('style.stylePanel.addSomePaddingTo')}</p>}
      </Section>

      <Section title={t('style.stylePanel.border')}>
        <Slider
          label={t('style.stylePanel.borderWidth')}
          value={borderOk ? border.width : 0}
          {...BORDER_WIDTH}
          step={1}
          format={(v) => (v === 0 ? t('common.state.none') : `${fmt.count(v)}px`)}
          disabled={!borderOk}
          onChange={(v) => setBorder({ width: v }, 'style.border.width')}
        />
        <Toggle
          label={t('style.stylePanel.frostedGlass')}
          title={t('style.stylePanel.aSeeThroughFrosted')}
          checked={borderOk && border.width > 0 && border.glass}
          disabled={!borderOk || border.width === 0}
          onChange={(v) => setBorder({ glass: v })}
        />
        <ColorDots
          label={t('style.stylePanel.borderColour')}
          value={border.color}
          presets={BORDER_COLORS}
          disabled={!borderOk || border.width === 0 || border.glass}
          onChange={(c, key) => setBorder({ color: c }, key)}
          mergeKey="style.border.color"
        />
        {!borderOk && <p className="hint">{t('style.stylePanel.deviceFramesHaveTheir')}</p>}
      </Section>

      <WatermarkSection project={project} />

      <BrandKitBar project={project} onNotice={onNotice} />

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
      <label className={`color-dot custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={t('common.colour.anyFor', { label: String(label) })} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
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

  const run = async (action: () => Promise<string>, failure: (reason: string) => string): Promise<void> => {
    setBusy(true)
    try {
      onNotice(await action())
    } catch (err) {
      onNotice(failure(saveErrorMessage(err)))
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      const stored = await window.api.saveStyleDefaults(lookOf(project))
      setSaved(true)
      const image = project.style.background.type === 'image'
      const logo = activeWatermark(project)?.kind === 'image' && !stored?.watermark
      if (!image && !logo) return t('style.stylePanel.savedAsDefault')
      // English keeps its reasons joined by "; " (merge group, output-and-languages §9.3); other languages say the whole sentence.
      if (uiLanguage() !== 'en') return t('style.stylePanel.defaultsLeft.whole', { left: image && logo ? 'both' : image ? 'image' : 'logo' })
      const left: string[] = []
      if (image) left.push(t('style.stylePanel.defaultsLeft.image'))
      if (logo) left.push(t('style.stylePanel.defaultsLeft.logo'))
      return t('style.stylePanel.savedAsDefaultLeft', { left: left.join('; ') })
    }, (reason) => t('style.stylePanel.defaultsNotSaved', { reason }))

  const reset = (): Promise<void> =>
    run(async () => {
      await window.api.resetStyleDefaults()
      setSaved(false)
      return t('style.stylePanel.defaultsReset')
    }, (reason) => t('style.stylePanel.defaultsNotReset', { reason }))

  return (
    <Section title={t('style.stylePanel.newRecordings')}>
      <p className="hint" data-testid="style-defaults-state">
        {saved
          ? t('style.stylePanel.newRecordingsStartWith')
          : t('style.stylePanel.newRecordingsStartWith2')}
      </p>
      <div className="defaults-actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={16} /> {t('style.stylePanel.saveAsDefaultFor')}
        </button>
        <button className="btn ghost" disabled={busy || !saved} onClick={() => void reset()} title={saved ? t('style.stylePanel.goBackToThe') : t('style.stylePanel.noDefaultsAreSaved')}>
          <Icon name="refresh" size={16} /> {t('style.stylePanel.resetDefaults')}
        </button>
      </div>
    </Section>
  )
}
