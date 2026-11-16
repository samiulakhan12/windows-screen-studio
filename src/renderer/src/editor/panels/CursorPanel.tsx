import { useEffect, useMemo, useRef, useState } from 'react'
import { pathSummary } from '../../../../shared/editor/inputEdits'
import { LOOK_LIMITS } from '../../../../shared/editor/styleDefaults'
import type { ClickRow } from '../../../../shared/engine/inputData'
import { mediaUrl } from '../../../../shared/mediaUrl'
import { CURSOR_STYLE_SCALE, cursorLook, type CursorLook } from '../../../../shared/render/cursorFx'
import type { ClickStyle, CursorStyle, CursorTrack, Project } from '../../../../shared/types'
import { reloadCursorImage } from '../../render/cursorLayer'
import { drawCursorSprite, type SpriteTheme } from '../../render/cursorSprites'
import { useEditor } from '../context'
import { pctFmt, Section, Slider, Toggle } from '../controls'
import { EditorIcon } from '../EditorIcon'
import type { InputActions } from '../Inspector'
import { IMPORTED_COPY, isImported } from '../../../../shared/import/imported'
import './cursorPanel.css'
import { t } from '../../../../shared/i18n/t'
import { fmt } from '../../../../shared/i18n/fmt'

const L = LOOK_LIMITS

const STYLES = (): { value: CursorStyle; label: string; title: string }[] => [
  { value: 'auto', label: t('zoom.cursorPanel.style.auto'), title: t('zoom.cursorPanel.style.auto.title') },
  { value: 'mac', label: t('zoom.cursorPanel.style.mac'), title: t('zoom.cursorPanel.style.mac.title') },
  { value: 'windows', label: t('zoom.cursorPanel.style.windows'), title: t('zoom.cursorPanel.style.windows.title') },
  { value: 'white', label: t('zoom.cursorPanel.style.white'), title: t('zoom.cursorPanel.style.white.title') },
  { value: 'black', label: t('zoom.cursorPanel.style.black'), title: t('zoom.cursorPanel.style.black.title') },
  { value: 'custom', label: t('zoom.cursorPanel.style.custom'), title: t('zoom.cursorPanel.style.custom.title') }
]

const CLICK_STYLES = (): { value: ClickStyle; label: string; title: string }[] => [
  { value: 'ripple', label: t('zoom.cursorPanel.click.ripple'), title: t('zoom.cursorPanel.click.ripple.title') },
  { value: 'ring', label: t('zoom.cursorPanel.click.ring'), title: t('zoom.cursorPanel.click.ring.title') },
  { value: 'pulse', label: t('zoom.cursorPanel.click.pulse'), title: t('zoom.cursorPanel.click.pulse.title') }
]

const HIGHLIGHT_COLORS = ['#facc15', '#ffffff', '#8b5cf6', '#38bdf8', '#f472b6', '#4ade80']
const CLICK_COLORS = ['#ffffff', '#facc15', '#8b5cf6', '#38bdf8', '#f472b6', '#111827']

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/* ---------- Cursor ---------- */

export function CursorPanel({
  project,
  cursor: track,
  recorded,
  clickRows,
  input
}: {
  project: Project
  /** The input as edited (what is drawn). */
  cursor: CursorTrack
  /** cursor.json as recorded (what straightening and the click counts read). */
  recorded: CursorTrack
  clickRows: ClickRow[]
  input: InputActions
}): JSX.Element {
  const { store, player } = useEditor()
  const { cursor } = project
  const look = cursorLook(cursor)
  const set = (patch: Partial<Project['cursor']>, key?: string): void => store.update((p) => ({ ...p, cursor: { ...p.cursor, ...patch } }), key)
  const setHighlight = (patch: Partial<CursorLook['highlight']>, key?: string): void =>
    store.update((p) => ({ ...p, cursor: { ...p.cursor, highlight: { ...cursorLook(p.cursor).highlight, ...patch } } }), key)
  const inVideo = project.capture.cursorInVideo
  const isWindow = project.capture.target === 'window'
  // A drawn cursor only makes sense when the real one is not already in the pixels.
  const smoothAvailable = track.valid && !inVideo
  const smoothOn = smoothAvailable && cursor.show
  const clicksOn = track.valid && cursor.clickEffect
  const clickCount = clickRows.length
  const ignoredCount = clickRows.filter((r) => r.ignored).length
  const straighten = smoothAvailable && !!project.inputEdits?.straighten
  // Only worked out while the option is on (the hint shows it).
  const paths = useMemo(() => (straighten ? pathSummary(recorded, project) : null), [straighten, recorded, project])

  // Custom image: picking copies it into the project folder as cursor.<ext>.
  const [busy, setBusy] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [imageVersion, setImageVersion] = useState(() => Date.now())
  const customUrl = useMemo(() => (cursor.customImage ? mediaUrl(project.id, cursor.customImage, imageVersion) : null), [project.id, cursor.customImage, imageVersion])
  const pickImage = async (): Promise<void> => {
    setBusy(true)
    setPickError(null)
    try {
      const picked = await window.api.pickCursorImage(project.id)
      if (!picked) return
      // A new image may replace an older one of the same name: decode it before switching.
      await reloadCursorImage(project.id, picked.path, picked.url)
      setImageVersion(Date.now())
      set({ style: 'custom', customImage: picked.path })
      player.invalidate()
    } catch (err) {
      setPickError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const chooseStyle = (style: CursorStyle): void => {
    if (style === 'custom' && !cursor.customImage) void pickImage()
    else set({ style })
  }

  return (
    <>
      {!track.valid ? (
        <p className="callout" data-testid="cursor-not-recorded" data-imported={isImported(project) || undefined}>
          <EditorIcon name="alert" size={16} />
          <span>
            {isImported(project)
              ? IMPORTED_COPY.cursor
              : isWindow
              ? t('zoom.cursorPanel.cursorMovementWasNot')
              : t('zoom.cursorPanel.cursorMovementWasNot2')}
          </span>
        </p>
      ) : inVideo ? (
        <p className="callout" data-testid="cursor-in-video">
          <EditorIcon name="alert" size={16} />
          <span>
            {isWindow ? t('zoom.cursorPanel.recordedCursorWindow') : t('zoom.cursorPanel.recordedCursorScreen')}
          </span>
        </p>
      ) : null}

      <Section title={t('zoom.cursorPanel.cursor')}>
        <Toggle
          label={t('zoom.cursorPanel.showSmoothCursor')}
          checked={smoothOn}
          disabled={!smoothAvailable}
          title={smoothAvailable ? undefined : t('zoom.cursorPanel.notAvailableTheRecorded')}
          onChange={(v) => set({ show: v })}
        />
        <div className="cursor-styles" role="radiogroup" aria-label={t('zoom.cursorPanel.cursorStyle')}>
          {STYLES().map((s) => (
            <button
              key={s.value}
              role="radio"
              aria-checked={look.style === s.value}
              aria-label={t('zoom.cursorPanel.styleName', { label: s.label })}
              title={s.title}
              disabled={!smoothOn || busy}
              className={`cursor-style ${look.style === s.value ? 'active' : ''}`}
              data-style={s.value}
              onClick={() => chooseStyle(s.value)}
            >
              <span className="cursor-style-stage">
                {s.value === 'custom' ? <CustomPreview url={customUrl} /> : <StylePreview theme={s.value} />}
              </span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        {look.style === 'custom' && cursor.customImage && (
          <div className="custom-cursor-row">
            <span className="muted small">{cursor.customImage}</span>
            <button className="btn ghost small-btn" disabled={!smoothOn || busy} onClick={() => void pickImage()}>{t('zoom.cursorPanel.changeImage')}</button>
          </div>
        )}
        {pickError && (
          <p className="callout" role="alert" data-testid="cursor-image-error">
            <EditorIcon name="alert" size={16} />
            <span>{pickError}</span>
          </p>
        )}
        <Slider label={t('common.label.size')} value={cursor.size} {...L.cursorSize} step={0.05} format={(v) => `${fmt.number(v, { max: 2 })}×`} disabled={!smoothOn} onChange={(v) => set({ size: v }, 'cursor.size')} />
      </Section>

      <Section title={t('zoom.cursorPanel.highlight')}>
        <Toggle label={t('zoom.cursorPanel.highlightCursor')} checked={smoothOn && look.highlight.enabled} disabled={!smoothOn} onChange={(v) => setHighlight({ enabled: v })} />
        <ColorRow
          label={t('zoom.cursorPanel.highlightColour')}
          value={look.highlight.color}
          presets={HIGHLIGHT_COLORS}
          disabled={!smoothOn || !look.highlight.enabled}
          onChange={(c, key) => setHighlight({ color: c }, key)}
          mergeKey="cursor.highlight.color"
        />
        <Slider
          label={t('zoom.cursorPanel.haloSize')}
          value={look.highlight.size}
          {...L.highlightSize}
          step={0.05}
          format={(v) => `${fmt.number(v, { max: 2 })}×`}
          disabled={!smoothOn || !look.highlight.enabled}
          onChange={(v) => setHighlight({ size: v }, 'cursor.highlight.size')}
        />
        <Slider
          label={t('common.label.opacity')}
          value={look.highlight.opacity}
          {...L.highlightOpacity}
          step={0.05}
          format={pctFmt}
          disabled={!smoothOn || !look.highlight.enabled}
          onChange={(v) => setHighlight({ opacity: v }, 'cursor.highlight.opacity')}
        />
      </Section>

      <Section
        title={t('zoom.cursorPanel.clicks')}
        aside={
          track.valid ? (
            <span className="small" title={t('zoom.cursorPanel.ignoreOrUseClicks')} data-testid="cursor-click-count">
              {ignoredCount > 0
                ? t('zoom.cursorPanel.clickCountIgnored', { count: clickCount, n: fmt.count(clickCount), ignored: fmt.count(ignoredCount) })
                : t('zoom.cursorPanel.clickCount', { count: clickCount, n: fmt.count(clickCount) })}
            </span>
          ) : undefined
        }
      >
        <Toggle label={t('zoom.cursorPanel.clickEffect')} checked={clicksOn} disabled={!track.valid} onChange={(v) => set({ clickEffect: v })} />
        <div className="click-styles" role="radiogroup" aria-label={t('zoom.cursorPanel.clickEffectStyle')}>
          {CLICK_STYLES().map((s) => (
            <button
              key={s.value}
              role="radio"
              aria-checked={look.clickStyle === s.value}
              aria-label={t('zoom.cursorPanel.clickStyleName', { label: s.label })}
              title={s.title}
              disabled={!clicksOn}
              className={`click-style ${look.clickStyle === s.value ? 'active' : ''}`}
              data-style={s.value}
              onClick={() => set({ clickStyle: s.value })}
            >
              <ClickIcon style={s.value} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <ColorRow label={t('zoom.cursorPanel.clickColour')} value={look.clickColor} presets={CLICK_COLORS} disabled={!clicksOn} onChange={(c, key) => set({ clickColor: c }, key)} mergeKey="cursor.clickColor" />
        <Toggle label={t('zoom.cursorPanel.clickSound')} checked={track.valid && look.clickSound} disabled={!track.valid} onChange={(v) => set({ clickSound: v })} />
        <Slider
          label={t('common.label.volume')}
          value={look.clickSoundVolume}
          {...L.clickSoundVolume}
          step={0.05}
          format={pctFmt}
          disabled={!track.valid || !look.clickSound}
          onChange={(v) => set({ clickSoundVolume: v }, 'cursor.clickSoundVolume')}
        />
      </Section>

      <Section title={t('common.label.motion')}>
        <Slider label={t('zoom.cursorPanel.smoothing')} value={cursor.smoothing} {...L.smoothing} step={0.05} format={pctFmt} disabled={!smoothOn} onChange={(v) => set({ smoothing: v }, 'cursor.smoothing')} />
        <Toggle
          label={t('zoom.cursorPanel.straightenMoves')}
          title={t('zoom.cursorPanel.replacesWobblyMovesBetween')}
          checked={smoothOn && straighten}
          disabled={!smoothOn}
          onChange={(v) => input.setStraighten(v)}
        />
        {smoothOn && paths && (
          <p className="hint" data-testid="straighten-summary">
            {t('zoom.cursorPanel.straightenedOf', { count: paths.moves, n: fmt.count(paths.moves), straightened: fmt.count(paths.straightened) })}
          </p>
        )}
        <Toggle label={t('zoom.cursorPanel.hideWhenIdle')} checked={smoothOn && cursor.hideWhenIdle} disabled={!smoothOn} onChange={(v) => set({ hideWhenIdle: v })} />
        <Toggle label={t('zoom.cursorPanel.tiltWhileMoving')} title={t('zoom.cursorPanel.leansTheCursorA')} checked={smoothOn && look.tilt} disabled={!smoothOn} onChange={(v) => set({ tilt: v })} />
        <Toggle label={t('zoom.cursorPanel.motionTrail')} title={t('zoom.cursorPanel.aShortFadingTrail')} checked={smoothOn && look.trail} disabled={!smoothOn} onChange={(v) => set({ trail: v })} />
        <Toggle label={t('zoom.cursorPanel.returnToStartAt')} checked={smoothOn && look.loopHome} disabled={!smoothOn} onChange={(v) => set({ loopHome: v })} />
        <p className="hint">{t('zoom.cursorPanel.glidesTheCursorBack')}</p>
      </Section>
    </>
  )
}

/* ---------- previews ---------- */

const PREVIEW_W = 46
const PREVIEW_H = 34

/** A cursor style drawn with the real sprite code, so the tile shows exactly what renders. */
function StylePreview({ theme }: { theme: SpriteTheme }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(PREVIEW_W * dpr)
    canvas.height = Math.round(PREVIEW_H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H)
    const height = 24 * CURSOR_STYLE_SCALE[theme]
    drawCursorSprite(ctx, 'arrow', PREVIEW_W / 2 - height * 0.22, (PREVIEW_H - height * 0.85) / 2, height, 1, 0, { theme })
  }, [theme])
  return <canvas ref={ref} style={{ width: PREVIEW_W, height: PREVIEW_H }} aria-hidden="true" />
}

/** The custom image, or a "choose image" glyph when there is none (or it cannot be read). */
function CustomPreview({ url }: { url: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (!url || failed) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3M12 4v11M7.5 8.5L12 4l4.5 4.5" />
      </svg>
    )
  }
  return <img className="custom-cursor-thumb" src={url} alt="" onError={() => setFailed(true)} />
}

function ClickIcon({ style }: { style: ClickStyle }): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="click-icon">
      {style === 'ripple' && (
        <>
          <circle cx="13" cy="13" r="10" fill="currentColor" opacity="0.22" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="13" cy="13" r="2.4" fill="currentColor" />
        </>
      )}
      {style === 'ring' && (
        <>
          <circle cx="13" cy="13" r="10.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
          <circle cx="13" cy="13" r="6" fill="none" stroke="currentColor" strokeWidth="2.2" />
        </>
      )}
      {style === 'pulse' && (
        <>
          <circle cx="13" cy="13" r="10.5" fill="currentColor" opacity="0.18" />
          <circle cx="13" cy="13" r="7" fill="currentColor" opacity="0.85" />
        </>
      )}
    </svg>
  )
}

/* ---------- colours ---------- */

function ColorRow({
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
  const custom = !presets.includes(value.toLowerCase())
  return (
    <div className={`color-row ${disabled ? 'disabled' : ''}`} role="group" aria-label={label}>
      {presets.map((c) => (
        <button
          key={c}
          className={`color-dot ${value.toLowerCase() === c ? 'active' : ''}`}
          style={{ background: c }}
          disabled={disabled}
          title={c}
          aria-label={`${label} ${c}`}
          aria-pressed={value.toLowerCase() === c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className={`color-dot custom ${custom ? 'active' : ''}`} title={t('common.colour.pickAny')} style={custom ? { background: value } : undefined}>
        <input type="color" aria-label={t('common.colour.anyFor', { label: String(label) })} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase(), mergeKey)} />
      </label>
    </div>
  )
}
