import { useEffect, useRef, useState } from 'react'
import { BRAND_CARD_LENGTH, DEFAULT_BRAND_LOGO, MAX_BRAND_COLORS, MAX_BRAND_FONTS, shownBrandKit, type BrandCard, type BrandKit, type BrandLogo } from '../../../shared/editor/brandKit'
import { BUILT_IN_PRESETS, parseUserPresets, type StylePreset } from '../../../shared/editor/stylePresets'
import { TITLE_BACKGROUNDS, TITLE_STYLES } from '../../../shared/editor/titles'
import { WATERMARK_LIMITS } from '../../../shared/engine/watermark'
import { cleanFontName, fontFamily } from '../../../shared/render/fonts'
import type { ProjectFont } from '../../../shared/types'
import { BRAND_KIT_CHANGED_EVENT } from './brandKitEvents'
import './brandKit.css'

const POSITIONS: { value: BrandLogo['position']; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
]

const NEW_CARD: Record<'intro' | 'outro', BrandCard> = {
  intro: { title: 'Your title', style: 'centered', background: 'solid', length: BRAND_CARD_LENGTH.default },
  outro: { title: 'Thanks for watching', style: 'centered', background: 'solid', length: BRAND_CARD_LENGTH.default }
}

const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const pct = (v: number): string => `${Math.round(v * 100)}%`

/** A blob: URL of a kit file's bytes (img-src allows blob:), revoked when it changes. */
function useKitFileUrl(file: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) return setUrl(null)
    let live = true
    let made: string | null = null
    const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
    window.api.brandFile(file).then(
      (bytes) => {
        if (!live || !bytes) return
        made = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        setUrl(made)
      },
      () => live && setUrl(null)
    )
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [file])
  return url
}

/** Loads a kit font for its sample line (registered from bytes, like project fonts). */
function useKitFont(font: ProjectFont): 'loading' | 'ready' | 'missing' {
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  useEffect(() => {
    let live = true
    let face: FontFace | null = null
    window.api
      .brandFile(font.file)
      .then(async (bytes) => {
        if (!bytes) throw new Error('missing')
        face = new FontFace(`${fontFamily(font.id)}-kit`, bytes as BufferSource)
        await face.load()
        if (!live) return
        document.fonts.add(face)
        setState('ready')
      })
      .catch(() => live && setState('missing'))
    return () => {
      live = false
      if (face) document.fonts.delete(face)
    }
  }, [font.id, font.file])
  return state
}

/**
 * Settings › Brand kit (E-03, docs/design/brand-kit.md §5): the logo, colours, fonts, intro and
 * outro, style preset and "Apply to new recordings", in one place. Every change is saved at once
 * (text after a short pause); the editor's "Apply brand kit" reads the saved kit. `reveal`
 * (Settings opened at `brand`) focuses its heading, so keys stay in the dialog, and scrolls it into view.
 */
export function BrandKitSection({ reveal = false }: { reveal?: boolean }): JSX.Element {
  const [kit, setKit] = useState<BrandKit | null>(null)
  const [presets, setPresets] = useState<StylePreset[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [color, setColor] = useState('#6252fc')
  const ref = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const timer = useRef(0)
  const pending = useRef<BrandKit | null>(null)

  useEffect(() => {
    window.api.getBrandKit().then(setKit, (err: unknown) => setError(ipcMessage(err)))
    window.api.getPref('stylePresets').then(
      (raw) => setPresets(parseUserPresets(raw)),
      () => setPresets([])
    )
  }, [])
  useEffect(() => {
    if (reveal) headingRef.current?.focus({ preventScroll: true })
  }, [reveal])
  useEffect(() => {
    if (reveal && kit) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [reveal, kit])

  const save = async (next: BrandKit): Promise<void> => {
    pending.current = null
    setSaved('saving')
    try {
      const stored = await window.api.saveBrandKit(next)
      setKit((k) => (k === next ? shownBrandKit(stored, next) : k))
      setSaved('saved')
      setError(null)
      window.dispatchEvent(new Event(BRAND_KIT_CHANGED_EVENT))
    } catch (err) {
      setSaved('idle')
      setError(`Your brand kit could not be saved: ${ipcMessage(err)}`)
    }
  }

  /** Changes the kit; saved at once, or after a short pause while typing (`typing`). */
  const update = (patch: Partial<BrandKit>, typing = false): void => {
    if (!kit) return
    const next = { ...kit, ...patch }
    setKit(next)
    window.clearTimeout(timer.current)
    if (typing) {
      pending.current = next
      timer.current = window.setTimeout(() => void save(next), 500)
    } else void save(next)
  }
  // Text typed just before closing is still saved.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (pending.current) void window.api.saveBrandKit(pending.current).then(() => window.dispatchEvent(new Event(BRAND_KIT_CHANGED_EVENT)))
    },
    []
  )

  const pick = async (kind: 'logo' | 'font'): Promise<void> => {
    if (!kit) return
    setError(null)
    try {
      const added = await window.api.pickBrandFile(kind)
      if (!added) return
      if (kind === 'logo')
        update({ logo: { ...DEFAULT_BRAND_LOGO, ...(kit.logo ? { position: kit.logo.position, size: kit.logo.size, opacity: kit.logo.opacity, margin: kit.logo.margin } : {}), file: added.file } })
      else if (added.font) {
        const fonts = [...kit.fonts, added.font]
        update({ fonts, headingFont: kit.headingFont ?? added.font.id, bodyFont: kit.bodyFont ?? added.font.id })
      }
    } catch (err) {
      setError(ipcMessage(err))
    }
  }

  if (!kit) {
    return (
      <section className="settings-section brand-kit" aria-labelledby="settings-brand-title" ref={ref}>
        <h3 id="settings-brand-title" ref={headingRef} tabIndex={-1}>
          Brand kit
        </h3>
        {error ? (
          <p className="callout" role="alert">
            {error}
          </p>
        ) : (
          <p className="settings-empty">Loading…</p>
        )}
      </section>
    )
  }

  const setLogo = (patch: Partial<BrandLogo>, typing = false): void => kit.logo && update({ logo: { ...kit.logo, ...patch } }, typing)
  const setCard = (which: 'intro' | 'outro', patch: Partial<BrandCard> | null, typing = false): void => {
    if (patch === null) return update({ [which]: undefined })
    update({ [which]: { ...(kit[which] ?? NEW_CARD[which]), ...patch } }, typing)
  }
  const allPresets = [...BUILT_IN_PRESETS, ...presets]

  return (
    <section className="settings-section brand-kit" aria-labelledby="settings-brand-title" ref={ref} data-testid="brand-kit-section">
      <h3 id="settings-brand-title" ref={headingRef} tabIndex={-1}>
        Brand kit
        <span className="brand-saved" role="status">
          {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : ''}
        </span>
      </h3>
      <p className="settings-empty">Your logo, colours, fonts, intro and outro, saved once. Apply them to a video from the editor's Style tab.</p>
      {error && (
        <p className="callout" role="alert" data-testid="brand-kit-error">
          {error}
        </p>
      )}

      <div className="brand-block">
        <h4>Logo</h4>
        <LogoRow kit={kit} onPick={() => void pick('logo')} onRemove={() => update({ logo: undefined })} />
        {kit.logo && (
          <div className="brand-grid">
            <label className="brand-field">
              <span className="settings-label">Position</span>
              <select value={kit.logo.position} onChange={(e) => setLogo({ position: e.target.value as BrandLogo['position'] })}>
                {POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <RangeField label="Size" value={kit.logo.size} {...WATERMARK_LIMITS.size} step={0.005} format={pct} onChange={(size) => setLogo({ size }, true)} />
            <RangeField label="Opacity" value={kit.logo.opacity} {...WATERMARK_LIMITS.opacity} step={0.05} format={pct} onChange={(opacity) => setLogo({ opacity }, true)} />
            <RangeField label="Distance from edge" value={kit.logo.margin} {...WATERMARK_LIMITS.margin} step={0.005} format={pct} onChange={(margin) => setLogo({ margin }, true)} />
          </div>
        )}
      </div>

      <div className="brand-block">
        <h4>Colours</h4>
        <div className="brand-colors" role="list" aria-label="Brand colours">
          {kit.colors.map((c) => (
            <span key={c} className="brand-color" role="listitem">
              <span className="brand-swatch" style={{ background: c }} aria-hidden="true" />
              <span className="brand-color-name">{c}</span>
              <button
                type="button"
                className="btn ghost icon-btn settings-small"
                aria-label={`Remove colour ${c}`}
                title="Remove"
                onClick={() => update({ colors: kit.colors.filter((x) => x !== c) })}
              >
                ×
              </button>
            </span>
          ))}
          {kit.colors.length < MAX_BRAND_COLORS && (
            <span className="brand-add-color">
              <input type="color" aria-label="New colour" value={color} onChange={(e) => setColor(e.target.value.toLowerCase())} />
              <button type="button" className="btn settings-small" onClick={() => !kit.colors.includes(color) && update({ colors: [...kit.colors, color] })}>
                Add colour
              </button>
            </span>
          )}
        </div>
        <p className="settings-empty small">The first colour fills the intro and outro cards; all of them show first in a title card's colour pickers.</p>
      </div>

      <div className="brand-block">
        <h4>Fonts</h4>
        {kit.fonts.length === 0 && <p className="settings-empty">No fonts yet. Add a TTF, OTF or WOFF2 file (15 MB at most).</p>}
        <ul className="brand-fonts">
          {kit.fonts.map((f) => (
            <FontRow
              key={f.id}
              font={f}
              onRename={(name) => update({ fonts: kit.fonts.map((g) => (g.id === f.id ? { ...g, name } : g)) }, true)}
              onRemove={() =>
                update({
                  fonts: kit.fonts.filter((g) => g.id !== f.id),
                  headingFont: kit.headingFont === f.id ? undefined : kit.headingFont,
                  bodyFont: kit.bodyFont === f.id ? undefined : kit.bodyFont
                })
              }
            />
          ))}
        </ul>
        {kit.fonts.length < MAX_BRAND_FONTS && (
          <button type="button" className="btn settings-small" onClick={() => void pick('font')}>
            Add font…
          </button>
        )}
        {kit.fonts.length > 0 && (
          <div className="brand-grid">
            <FontSelect label="Headings (title cards)" fonts={kit.fonts} value={kit.headingFont} onChange={(headingFont) => update({ headingFont })} />
            <FontSelect label="Text (captions and text)" fonts={kit.fonts} value={kit.bodyFont} onChange={(bodyFont) => update({ bodyFont })} />
          </div>
        )}
      </div>

      {(['intro', 'outro'] as const).map((which) => (
        <CardBlock key={which} which={which} card={kit[which]} onChange={(patch, typing) => setCard(which, patch, typing)} />
      ))}

      <div className="brand-block">
        <h4>Style preset</h4>
        <label className="brand-field">
          <span className="settings-label">Look applied with the kit</span>
          <select
            value={kit.preset ? (allPresets.find((p) => p.name === kit.preset!.name)?.id ?? '__kept__') : ''}
            onChange={(e) => {
              const p = allPresets.find((x) => x.id === e.target.value)
              update({ preset: p ? { name: p.name, look: p.look } : undefined })
            }}
          >
            <option value="">None (keep the video's look)</option>
            {kit.preset && !allPresets.some((p) => p.name === kit.preset!.name) && <option value="__kept__">{kit.preset.name}</option>}
            {allPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="toggle brand-auto">
        <span>Apply to new recordings</span>
        <input type="checkbox" aria-label="Apply to new recordings" checked={kit.autoApply} onChange={(e) => update({ autoApply: e.target.checked })} />
      </label>
      <p className="settings-empty small">{kit.autoApply ? 'New recordings start with your brand kit.' : 'New recordings start without it; apply it from the editor.'}</p>
    </section>
  )
}

function LogoRow({ kit, onPick, onRemove }: { kit: BrandKit; onPick: () => void; onRemove: () => void }): JSX.Element {
  const url = useKitFileUrl(kit.logo?.file)
  return (
    <div className="brand-logo-row">
      <div className="brand-logo-preview" aria-hidden={!url}>
        {url ? <img src={url} alt="Your logo" /> : <span className="settings-empty small">No logo</span>}
      </div>
      <button type="button" className="btn settings-small" onClick={onPick}>
        {kit.logo ? 'Change logo…' : 'Choose logo…'}
      </button>
      {kit.logo && (
        <button type="button" className="btn ghost settings-small" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  )
}

function FontRow({ font, onRename, onRemove }: { font: ProjectFont; onRename: (name: string) => void; onRemove: () => void }): JSX.Element {
  const state = useKitFont(font)
  const [name, setName] = useState(font.name)
  return (
    <li className="brand-font">
      <input
        className="settings-input"
        aria-label={`Name of font ${font.name}`}
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          const clean = cleanFontName(e.target.value)
          if (clean) onRename(clean)
        }}
      />
      <span className="brand-font-sample" style={state === 'ready' ? { fontFamily: `"${fontFamily(font.id)}-kit"` } : undefined}>
        {state === 'missing' ? 'This font could not be read.' : 'The quick brown fox'}
      </span>
      <button type="button" className="btn ghost settings-small" aria-label={`Remove font ${font.name}`} onClick={onRemove}>
        Remove
      </button>
    </li>
  )
}

function FontSelect({ label, fonts, value, onChange }: { label: string; fonts: ProjectFont[]; value: string | undefined; onChange: (id: string | undefined) => void }): JSX.Element {
  return (
    <label className="brand-field">
      <span className="settings-label">{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Default (Segoe UI)</option>
        {fonts.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function CardBlock({ which, card, onChange }: { which: 'intro' | 'outro'; card: BrandCard | undefined; onChange: (patch: Partial<BrandCard> | null, typing?: boolean) => void }): JSX.Element {
  const name = which === 'intro' ? 'Intro' : 'Outro'
  return (
    <div className="brand-block">
      <label className="toggle">
        <span>{name} title card</span>
        <input type="checkbox" aria-label={`${name} title card`} checked={!!card} onChange={(e) => onChange(e.target.checked ? {} : null)} />
      </label>
      {card && (
        <div className="brand-grid">
          <label className="brand-field">
            <span className="settings-label">Title</span>
            <input className="settings-input" aria-label={`${name} title`} value={card.title} maxLength={200} onChange={(e) => onChange({ title: e.target.value }, true)} />
          </label>
          <label className="brand-field">
            <span className="settings-label">Subtitle</span>
            <input
              className="settings-input"
              aria-label={`${name} subtitle`}
              value={card.subtitle ?? ''}
              maxLength={200}
              placeholder="Optional"
              onChange={(e) => onChange({ subtitle: e.target.value }, true)}
            />
          </label>
          <label className="brand-field">
            <span className="settings-label">Style</span>
            <select value={card.style} onChange={(e) => onChange({ style: e.target.value as BrandCard['style'] })}>
              {TITLE_STYLES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="brand-field">
            <span className="settings-label">Background</span>
            <select value={card.background} onChange={(e) => onChange({ background: e.target.value as BrandCard['background'] })}>
              {TITLE_BACKGROUNDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <RangeField
            label="Length"
            value={card.length}
            min={BRAND_CARD_LENGTH.min}
            max={BRAND_CARD_LENGTH.max}
            step={0.5}
            format={(v) => `${v.toFixed(1)} s`}
            onChange={(length) => onChange({ length }, true)}
          />
        </div>
      )}
    </div>
  )
}

function RangeField(props: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }): JSX.Element {
  return (
    <label className="brand-field">
      <span className="settings-label brand-range-head">
        <span>{props.label}</span>
        <span>{props.format(props.value)}</span>
      </span>
      <input type="range" aria-label={props.label} min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  )
}
